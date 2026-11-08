import { normalizeSourceIp } from "./session-state";

export type EventType =
  | "unconfirmed_lure_view"
  | "invalid_key_attempt"
  | "confirmed_reuse"
  | "block";

export interface EventInput {
  installationId: string;
  type: EventType;
  route: "env-file" | "bait-api" | null;
  sourceIp: string | null;
  confirmed: boolean;
}

export interface EventRecord extends EventInput {
  id: string;
  createdAt: number;
}

export interface D1Result<T = unknown> {
  results: T[];
  success?: boolean;
  meta?: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(
    columnName?: string,
  ): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface EventDatabase {
  prepare(query: string): D1PreparedStatement;
}

export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function createEventRecord(
  input: EventInput,
  now = Date.now(),
): EventRecord {
  if (!input.installationId.trim()) {
    throw new Error("Installation ID is required to record an event");
  }
  const sourceIp = input.sourceIp === null
    ? null
    : normalizeSourceIp(input.sourceIp);
  if (input.sourceIp !== null && sourceIp === null) {
    throw new Error("Event source IP is invalid");
  }

  const event: EventRecord = {
    id: crypto.randomUUID(),
    installationId: input.installationId,
    type: input.type,
    route: input.route,
    sourceIp,
    confirmed: input.confirmed,
    createdAt: now,
  };
  return event;
}

export function prepareEventInsert(
  database: EventDatabase,
  event: EventRecord,
): D1PreparedStatement {
  return database.prepare(
    `INSERT INTO events (
      id, installation_id, type, route, source_ip, confirmed, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    event.id,
    event.installationId,
    event.type,
    event.route,
    event.sourceIp,
    event.confirmed ? 1 : 0,
    event.createdAt,
  );
}

export async function recordEvent(
  database: EventDatabase,
  input: EventInput,
  now = Date.now(),
): Promise<EventRecord> {
  const event = createEventRecord(input, now);
  await prepareEventInsert(database, event).run();
  return event;
}

export async function listEvents(
  database: EventDatabase,
  installationId: string,
  limit = 100,
): Promise<EventRecord[]> {
  const boundedLimit = Math.min(1_000, Math.max(1, Math.floor(limit)));
  const result = await database.prepare(
    `SELECT id, installation_id, type, route, source_ip, confirmed, created_at
      FROM events
      WHERE installation_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
  ).bind(installationId, boundedLimit).all<StoredEvent>();
  return result.results.map(mapEvent);
}

export async function getEvent(
  database: EventDatabase,
  id: string,
): Promise<EventRecord | null> {
  const row = await database.prepare(
    `SELECT id, installation_id, type, route, source_ip, confirmed, created_at
      FROM events WHERE id = ?`,
  ).bind(id).first<StoredEvent>();
  return row ? mapEvent(row) : null;
}

export async function deleteExpiredEvents(
  database: EventDatabase,
  now = Date.now(),
): Promise<number> {
  const cutoff = now - EVENT_RETENTION_MS;
  const result = await database.prepare(
    "DELETE FROM events WHERE created_at <= ?",
  ).bind(cutoff).run();
  return result.meta?.changes ?? 0;
}

interface StoredEvent {
  id: string;
  installation_id: string;
  type: EventType;
  route: EventRecord["route"];
  source_ip: string | null;
  confirmed: number;
  created_at: number;
}

function mapEvent(row: StoredEvent): EventRecord {
  return {
    id: row.id,
    installationId: row.installation_id,
    type: row.type,
    route: row.route,
    sourceIp: row.source_ip,
    confirmed: row.confirmed === 1,
    createdAt: row.created_at,
  };
}
