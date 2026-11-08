import type { LureAlert } from "./lures";
import type {
  D1PreparedStatement,
  EventDatabase,
  EventRecord,
} from "./events";

export const ALERT_GROUP_WINDOW_MS = 5 * 60 * 1_000;
export const ALERT_MAX_ATTEMPTS = 8;
export const ALERT_BASE_BACKOFF_MS = 30_000;
export const ALERT_MAX_BACKOFF_MS = 60 * 60 * 1_000;
const MAX_PENDING_BATCH = 100;
const STALE_SEND_MS = 60_000;

interface AlertDatabase extends EventDatabase {
  prepare(query: string): D1PreparedStatement;
}

interface RuntimeSetting {
  last_alert_at: number | null;
  pending_outbox_id: string | null;
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
): Promise<QueuedAlert> {
  const setting = await database.prepare(
    `SELECT last_alert_at, pending_outbox_id
      FROM runtime_settings WHERE installation_id = ?`,
  ).bind(event.installationId).first<RuntimeSetting>();

  if (setting?.pending_outbox_id) {
    const pending = await getOutbox(database, setting.pending_outbox_id);
    if (pending?.status === "pending" && pending.attempts === 0) {
      const payload = JSON.parse(pending.payload_json) as AlertPayload;
      payload.alerts.push(toAlert(event, alert));
      const eventIds = JSON.parse(pending.event_ids_json) as string[];
      eventIds.push(event.id);
      await database.prepare(
        `UPDATE webhook_outbox
          SET event_ids_json = ?, payload_json = ?, updated_at = ?
          WHERE id = ? AND status = 'pending' AND attempts = 0`,
      ).bind(
        JSON.stringify(eventIds),
        JSON.stringify(payload),
        now,
        pending.id,
      ).run();
      return {
        outboxId: pending.id,
        dispatchImmediately: pending.next_attempt_at <= now,
      };
    }
  }

  const lastAlertAt = setting?.last_alert_at ?? null;
  const sendNow = lastAlertAt === null || now >= lastAlertAt + ALERT_GROUP_WINDOW_MS;
  const dueAt = sendNow ? now : lastAlertAt + ALERT_GROUP_WINDOW_MS;
  const outboxId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const payload: AlertPayload = {
    installationId: event.installationId,
    alerts: [toAlert(event, alert)],
  };
  await database.prepare(
    `INSERT INTO webhook_outbox (
      id, installation_id, event_ids_json, payload_json, idempotency_key,
      status, attempts, next_attempt_at, created_at, updated_at, last_error
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL)`,
  ).bind(
    outboxId,
    event.installationId,
    JSON.stringify([event.id]),
    JSON.stringify(payload),
    idempotencyKey,
    dueAt,
    now,
    now,
  ).run();

  await database.prepare(
    `INSERT INTO runtime_settings (installation_id, last_alert_at, pending_outbox_id)
      VALUES (?, ?, ?)
      ON CONFLICT(installation_id) DO UPDATE SET
        last_alert_at = excluded.last_alert_at,
        pending_outbox_id = excluded.pending_outbox_id`,
  ).bind(
    event.installationId,
    sendNow ? now : lastAlertAt,
    sendNow ? null : outboxId,
  ).run();

  return { outboxId, dispatchImmediately: sendNow };
}

export async function processPendingAlerts(
  database: AlertDatabase,
  webhookUrl: string | undefined,
  now = Date.now(),
): Promise<number> {
  await database.prepare(
    `UPDATE webhook_outbox
      SET status = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE status = 'sending' AND updated_at <= ?`,
  ).bind(now, now, now - STALE_SEND_MS).run();
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
): Promise<number> {
  const cutoff = now - 30 * 24 * 60 * 60 * 1_000;
  const result = await database.prepare(
    `DELETE FROM webhook_outbox
      WHERE created_at <= ? AND status IN ('delivered', 'dead')`,
  ).bind(cutoff).run();
  return result.meta?.changes ?? 0;
}

export async function deliverOutbox(
  database: AlertDatabase,
  outboxId: string,
  webhookUrl: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  const outbox = await getOutbox(database, outboxId);
  if (
    !outbox
    || outbox.status !== "pending"
    || outbox.next_attempt_at > now
  ) {
    return false;
  }

  const attempts = outbox.attempts + 1;
  const claim = await database.prepare(
    `UPDATE webhook_outbox
      SET status = 'sending', attempts = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`,
  ).bind(attempts, now, outboxId).run();
  if (claim.meta?.changes === 0) return false;
  await database.prepare(
    `UPDATE runtime_settings
      SET last_alert_at = ?, pending_outbox_id = NULL
      WHERE installation_id = ? AND pending_outbox_id = ?`,
  ).bind(now, outbox.installation_id, outboxId).run();

  try {
    const destination = validateWebhookUrl(webhookUrl);
    const response = await fetch(destination, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": outbox.idempotency_key,
      },
      body: outbox.payload_json,
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
    await database.prepare(
      `UPDATE webhook_outbox
        SET status = ?, next_attempt_at = ?, updated_at = ?, last_error = ?
        WHERE id = ? AND status = 'sending'`,
    ).bind(status, retryAt, now, reason, outboxId).run();
    console.error("Webhook delivery failed; alert retained in D1 outbox");
    return false;
  }
}

export function backoffForAttempt(attempt: number): number {
  const exponent = Math.max(0, Math.min(20, attempt - 1));
  return Math.min(ALERT_BASE_BACKOFF_MS * 2 ** exponent, ALERT_MAX_BACKOFF_MS);
}

async function getOutbox(
  database: AlertDatabase,
  id: string,
): Promise<OutboxRecord | null> {
  return database.prepare(
    `SELECT id, installation_id, event_ids_json, payload_json, idempotency_key,
      status, attempts, next_attempt_at
      FROM webhook_outbox WHERE id = ?`,
  ).bind(id).first<OutboxRecord>();
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
