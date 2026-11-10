import type { LureAlert } from "./lures";
import type {
  D1PreparedStatement,
  D1Result,
  EventInput,
  EventDatabase,
  EventRecord,
} from "./events";
import { createEventRecord, prepareEventInsert } from "./events";

export const ALERT_GROUP_WINDOW_MS = 5 * 60 * 1_000;
export const ALERT_MAX_ATTEMPTS = 8;
export const ALERT_BASE_BACKOFF_MS = 30_000;
export const ALERT_MAX_BACKOFF_MS = 60 * 60 * 1_000;
export const ALERT_DELIVERY_TIMEOUT_MS = 30_000;
const MAX_PENDING_BATCH = 100;
const STALE_SEND_MS = 60_000;

interface AlertDatabase extends EventDatabase {
  batch?<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface OutboxRecord {
  id: string;
  installation_id: string;
  event_ids_json: string;
  payload_json: string;
  idempotency_key: string;
  status: "pending" | "sending" | "delivered" | "dead";
  attempts: number;
  next_attempt_at: number;
}

interface AlertPayload {
  installationId: string;
  alerts: {
    eventId: string;
    type: LureAlert["type"];
    route: LureAlert["route"];
    source: string | null;
    occurredAt: number;
  }[];
}

export interface QueuedAlert {
  outboxId: string;
  dispatchImmediately: boolean;
}

export async function enqueueAlert(
  database: AlertDatabase,
  event: EventRecord,
  alert: LureAlert,
  now = Date.now(),
  groupWindowMs = ALERT_GROUP_WINDOW_MS,
): Promise<QueuedAlert> {
  return enqueueAlertTransaction(database, event, alert, now, false, groupWindowMs);
}

export async function enqueueAlertWithEvent(
  database: AlertDatabase,
  input: EventInput,
  alert: LureAlert,
  now = Date.now(),
  groupWindowMs = ALERT_GROUP_WINDOW_MS,
): Promise<QueuedAlert & { event: EventRecord }> {
  const event = createEventRecord(input, now);
  const queued = await enqueueAlertTransaction(
    database,
    event,
    alert,
    now,
    true,
    groupWindowMs,
  );
  return { ...queued, event };
}

async function enqueueAlertTransaction(
  database: AlertDatabase,
  event: EventRecord,
  alert: LureAlert,
  now: number,
  includeEvent = false,
  groupWindowMs = ALERT_GROUP_WINDOW_MS,
): Promise<QueuedAlert> {
  const outboxId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const payload: AlertPayload = {
    installationId: event.installationId,
    alerts: [toAlert(event, alert)],
  };
  const statements = [
    ...(includeEvent ? [prepareEventInsert(database, event)] : []),
    database.prepare(
      `INSERT INTO runtime_settings (installation_id)
        VALUES (?) ON CONFLICT(installation_id) DO NOTHING`,
    ).bind(event.installationId),
    database.prepare(
      `UPDATE webhook_outbox
        SET event_ids_json = json_insert(event_ids_json, '$[#]', ?),
          payload_json = json_insert(payload_json, '$.alerts[#]', json(?)),
          updated_at = ?
        WHERE id = (
          SELECT pending_outbox_id FROM runtime_settings WHERE installation_id = ?
        ) AND status = 'pending' AND attempts = 0
          AND NOT EXISTS (SELECT 1 FROM json_each(event_ids_json) WHERE value = ?)`,
    ).bind(event.id, JSON.stringify(toAlert(event, alert)), now, event.installationId, event.id),
    database.prepare(
      `INSERT INTO webhook_outbox (
        id, installation_id, event_ids_json, payload_json, idempotency_key,
        status, attempts, next_attempt_at, created_at, updated_at, last_error
      )
      SELECT ?, installation_id, ?, ?, ?, 'pending', 0,
        CASE WHEN last_alert_at IS NULL THEN ?
          ELSE MAX(?, last_alert_at + ?) END, ?, ?, NULL
      FROM runtime_settings WHERE installation_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM webhook_outbox WHERE id = pending_outbox_id
            AND status = 'pending' AND attempts = 0
        )`,
    ).bind(
      outboxId, JSON.stringify([event.id]), JSON.stringify(payload), idempotencyKey,
      now, now, groupWindowMs, now, now, event.installationId,
    ),
    database.prepare(
      `UPDATE runtime_settings
        SET last_alert_at = (SELECT next_attempt_at FROM webhook_outbox WHERE id = ?),
          pending_outbox_id = ?
        WHERE installation_id = ? AND EXISTS (SELECT 1 FROM webhook_outbox WHERE id = ?)`,
    ).bind(outboxId, outboxId, event.installationId, outboxId),
    database.prepare(
      `SELECT id, (id = ? AND next_attempt_at <= ?) AS dispatch_immediately
        FROM webhook_outbox WHERE id = (
          SELECT pending_outbox_id FROM runtime_settings WHERE installation_id = ?
        )`,
    ).bind(outboxId, now, event.installationId),
  ];
  // D1 batch is a transaction: appends, group creation, and slot reservation
  // cannot interleave with another enqueue or delivery claim.
  const results = await alertTransaction<{
    id: string;
    dispatch_immediately: number;
  }>(database, statements);
  const queued = results[statements.length - 1]?.results[0];
  if (!queued) throw new Error("D1 alert transaction did not persist an outbox group");
  return {
    outboxId: queued.id,
    dispatchImmediately: queued.dispatch_immediately === 1,
  };
}

export async function processPendingAlerts(
  database: AlertDatabase,
  webhookUrl: string | undefined,
  now = Date.now(),
): Promise<number> {
  await alertTransaction(database, [
    database.prepare(
      `UPDATE webhook_outbox
        SET status = 'dead', updated_at = ?,
          last_error = COALESCE(last_error, 'Maximum alert delivery attempts reached')
        WHERE attempts >= ? AND (
          status = 'pending'
          OR (status = 'sending' AND updated_at <= ?)
        )`,
    ).bind(now, ALERT_MAX_ATTEMPTS, now - STALE_SEND_MS),
    database.prepare(
      `UPDATE runtime_settings
        SET pending_outbox_id = NULL
        WHERE pending_outbox_id IN (
          SELECT id FROM webhook_outbox
          WHERE status = 'dead' AND attempts >= ?
        )`,
    ).bind(ALERT_MAX_ATTEMPTS),
    database.prepare(
      `UPDATE webhook_outbox
        SET status = 'pending', next_attempt_at = ?, updated_at = ?
        WHERE status = 'sending' AND attempts < ? AND updated_at <= ?`,
    ).bind(now, now, ALERT_MAX_ATTEMPTS, now - STALE_SEND_MS),
  ]);
  const due = await database.prepare(
    `SELECT id FROM webhook_outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at, created_at
      LIMIT ?`,
  ).bind(now, MAX_PENDING_BATCH).all<{ id: string }>();

  for (const row of due.results) {
    await deliverOutbox(database, row.id, webhookUrl, now);
  }
  return due.results.length;
}

export async function deleteExpiredOutbox(
  database: AlertDatabase,
  now = Date.now(),
  retentionMs = 30 * 24 * 60 * 60 * 1_000,
): Promise<number> {
  const maximumRetention = 30 * 24 * 60 * 60 * 1_000;
  const boundedRetention = Number.isFinite(retentionMs)
    ? Math.min(maximumRetention, Math.max(1, retentionMs))
    : maximumRetention;
  const cutoff = now - boundedRetention;
  const results = await alertTransaction(database, [
    database.prepare(
      `UPDATE runtime_settings SET pending_outbox_id = NULL
        WHERE pending_outbox_id IN (
          SELECT id FROM webhook_outbox WHERE created_at <= ?
        )`,
    ).bind(cutoff),
    database.prepare(
      "DELETE FROM webhook_outbox WHERE created_at <= ?",
    ).bind(cutoff),
  ]);
  return results[1]?.meta?.changes ?? 0;
}

export async function deliverOutbox(
  database: AlertDatabase,
  outboxId: string,
  webhookUrl: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  // RETURNING snapshots the payload at the claim, not before a concurrent append.
  const claimResults = await alertTransaction<OutboxRecord>(database, [
    database.prepare(
      `UPDATE webhook_outbox
        SET status = 'dead', updated_at = ?,
          last_error = COALESCE(last_error, 'Maximum alert delivery attempts reached')
        WHERE id = ? AND status = 'pending' AND attempts >= ?`,
    ).bind(now, outboxId, ALERT_MAX_ATTEMPTS),
    database.prepare(
      `UPDATE runtime_settings
        SET pending_outbox_id = NULL
        WHERE pending_outbox_id = ? AND EXISTS (
          SELECT 1 FROM webhook_outbox WHERE id = ? AND status = 'dead'
        )`,
    ).bind(outboxId, outboxId),
    database.prepare(
      `UPDATE webhook_outbox
        SET status = 'sending', attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status = 'pending' AND attempts < ? AND next_attempt_at <= ?
        RETURNING id, installation_id, event_ids_json, payload_json, idempotency_key,
          status, attempts, next_attempt_at`,
    ).bind(now, outboxId, ALERT_MAX_ATTEMPTS, now),
    database.prepare(
      `UPDATE runtime_settings
        SET last_alert_at = MAX(last_alert_at, ?), pending_outbox_id = NULL
        WHERE pending_outbox_id = ? AND EXISTS (
          SELECT 1 FROM webhook_outbox WHERE id = ? AND status = 'sending'
        )`,
    ).bind(now, outboxId, outboxId),
  ]);
  const claim = claimResults[2];
  const outbox = claim?.results[0];
  if (!outbox) return false;
  const attempts = outbox.attempts;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    ALERT_DELIVERY_TIMEOUT_MS,
  );

  try {
    const destination = validateWebhookUrl(webhookUrl);
    const response = await fetch(destination, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        // Receivers can deduplicate uncertain outcomes across retries.
        "Idempotency-Key": outbox.idempotency_key,
      },
      body: outbox.payload_json,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new WebhookDeliveryError(`Webhook returned HTTP ${response.status}`);
    }
    await database.prepare(
      `UPDATE webhook_outbox
        SET status = 'delivered', updated_at = ?, last_error = NULL
        WHERE id = ? AND status = 'sending'`,
    ).bind(now, outboxId).run();
    return true;
  } catch (error) {
    const status = attempts >= ALERT_MAX_ATTEMPTS ? "dead" : "pending";
    const retryAt = now + backoffForAttempt(attempts);
    const reason = error instanceof WebhookDeliveryError
      ? error.safeMessage
      : "Webhook delivery failed";
    await alertTransaction(database, [
      database.prepare(
        `UPDATE webhook_outbox
          SET status = ?, next_attempt_at = ?, updated_at = ?, last_error = ?
          WHERE id = ? AND status = 'sending'`,
      ).bind(status, retryAt, now, reason, outboxId),
      database.prepare(
        `UPDATE runtime_settings
          SET pending_outbox_id = NULL
          WHERE pending_outbox_id = ? AND EXISTS (
            SELECT 1 FROM webhook_outbox WHERE id = ? AND status = 'dead'
          )`,
      ).bind(outboxId, outboxId),
    ]);
    console.error("Webhook delivery failed; alert retained in D1 outbox");
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function backoffForAttempt(attempt: number): number {
  const exponent = Math.max(0, Math.min(20, attempt - 1));
  return Math.min(ALERT_BASE_BACKOFF_MS * 2 ** exponent, ALERT_MAX_BACKOFF_MS);
}

async function alertTransaction<T>(
  database: AlertDatabase,
  statements: D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  if (!database.batch) throw new Error("Alert grouping requires transactional D1 batch support");
  return database.batch<T>(statements);
}

function toAlert(event: EventRecord, alert: LureAlert): AlertPayload["alerts"][number] {
  return {
    eventId: event.id,
    type: alert.type,
    route: alert.route,
    source: event.sourceIp,
    occurredAt: event.createdAt,
  };
}

function validateWebhookUrl(value: string | undefined): string {
  if (!value) {
    throw new WebhookDeliveryError("Webhook URL is not configured");
  }
  try {
    const destination = new URL(value);
    if (
      destination.protocol !== "https:"
      || destination.username
      || destination.password
    ) {
      throw new Error();
    }
    return destination.toString();
  } catch {
    throw new WebhookDeliveryError("Webhook URL must be a valid HTTPS URL");
  }
}

class WebhookDeliveryError extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
  }
}
