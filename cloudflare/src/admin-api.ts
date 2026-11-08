import type { Env } from "./index";
import {
  normalizeSourceIp,
  deriveAgentSessionName,
} from "./session-state";
import type { EventDatabase, EventRecord } from "./events";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_ACTIVE_SOURCE_CANDIDATES = 1_000;
const ACCESS_ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";
const ACCESS_CLOCK_SKEW_SECONDS = 30;
const ACCESS_CERT_CACHE_MS = 5 * 60 * 1_000;
const accessKeyCache = new Map<string, {
  expiresAt: number;
  keys: JsonWebKey[];
}>();

export interface AdminActor {
  email: string;
  subject: string;
}

export interface RuntimeSettings {
  luresEnabled: boolean;
  mazeDurationMinutes: number;
  blockDurationHours: number;
  responseBudget: number;
  alertGroupingMinutes: number;
  retentionDays: number;
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  luresEnabled: true,
  mazeDurationMinutes: 15,
  blockDurationHours: 24,
  responseBudget: 100,
  alertGroupingMinutes: 5,
  retentionDays: 30,
};

type AdminDatabase = EventDatabase;

interface StoredEvent {
  id: string;
  installation_id: string;
  type: EventRecord["type"];
  route: EventRecord["route"];
  source_ip: string | null;
  confirmed: number;
  created_at: number;
}

interface AccessClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  email?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

interface AccessHeader {
  alg?: unknown;
  kid?: unknown;
}

export async function validateAccessAssertion(
  request: Request,
  env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">,
  fetcher: typeof fetch = fetch,
): Promise<AdminActor> {
  const token = request.headers.get(ACCESS_ASSERTION_HEADER);
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const audience = env.ACCESS_AUD?.trim();
  if (!token || token.length > 16_384 || !teamDomain || !audience) {
    throw new Error("Invalid Access identity");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid Access identity");
  const header = parseJwtPart<AccessHeader>(parts[0]);
  const claims = parseJwtPart<AccessClaims>(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string"
    || !/^[A-Za-z0-9._-]{1,256}$/.test(header.kid)) {
    throw new Error("Invalid Access identity");
  }

  const issuer = `https://${teamDomain}`;
  if (claims.iss !== issuer || !hasAudience(claims.aud, audience)) {
    throw new Error("Invalid Access identity");
  }
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (
    typeof claims.exp !== "number"
    || !Number.isSafeInteger(claims.exp)
    || claims.exp <= nowSeconds - ACCESS_CLOCK_SKEW_SECONDS
    || (claims.nbf !== undefined
      && (typeof claims.nbf !== "number"
        || !Number.isSafeInteger(claims.nbf)
        || claims.nbf > nowSeconds + ACCESS_CLOCK_SKEW_SECONDS))
  ) {
    throw new Error("Invalid Access identity");
  }
  if (
    typeof claims.sub !== "string"
    || claims.sub.length < 1
    || claims.sub.length > 512
    || /[\u0000-\u001f\u007f]/.test(claims.sub)
    || typeof claims.email !== "string"
    || claims.email.length > 320
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
  ) {
    throw new Error("Invalid Access identity");
  }

  const certUrl = `${issuer}/cdn-cgi/access/certs`;
  const jwk = await findAccessKey(certUrl, header.kid, fetcher);
  if (!jwk || jwk.alg && jwk.alg !== "RS256" || jwk.use && jwk.use !== "sig") {
    throw new Error("Invalid Access identity");
  }
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = decodeBase64Url(parts[2]);
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength,
    ) as ArrayBuffer,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!validSignature) throw new Error("Invalid Access identity");
  return { email: claims.email, subject: claims.sub };
}

export async function handleAdminApiRequest(
  request: Request,
  env: Env,
  actor: AdminActor,
  now = Date.now(),
): Promise<Response> {
  try {
    if (!env.EVENTS_DB || !env.INSTALLATION_ID) {
      return errorResponse(503, "Admin storage is unavailable");
    }
    if (!isValidActor(actor)) return errorResponse(401, "Authentication required");
    if (request.method !== "GET" && !hasSameOrigin(request)) {
      return errorResponse(403, "Request origin is not allowed");
    }

    const url = new URL(request.url);
    const route = url.pathname.slice("/api/admin".length) || "/";
    const database = env.EVENTS_DB as AdminDatabase;
    switch (route) {
      case "/events":
        if (request.method !== "GET") return methodNotAllowed();
        return await listAdminEvents(database, env.INSTALLATION_ID, url);
      case "/blocks":
        if (request.method !== "GET") return methodNotAllowed();
        return await listActiveBlocks(database, env, now);
      case "/settings":
        if (request.method === "GET") {
          return jsonResponse({
            ...await ensureRuntimeSettings(database, env),
            deployment: deploymentSettings(env),
          });
        }
        if (request.method === "PUT") {
          return await updateRuntimeSettings(request, database, env);
        }
        return methodNotAllowed();
      case "/allowlist":
        if (request.method === "GET") {
          return await listAllowlist(database, env);
        }
        if (request.method === "POST") {
          return await addAllowlistSource(request, database, env, actor, now);
        }
        return methodNotAllowed();
      case "/audit":
        if (request.method !== "GET") return methodNotAllowed();
        return await listAudit(database, env, url);
      default:
        if (route.startsWith("/events/") && request.method === "GET") {
          return await getAdminEvent(
            database,
            env.INSTALLATION_ID,
            route.slice("/events/".length),
          );
        }
        const unblockMatch = /^\/blocks\/([^/]+)\/unblock$/.exec(route);
        if (unblockMatch && request.method === "POST") {
          return await manuallyUnblock(
            database,
            env,
            decodePathSegment(unblockMatch[1]),
            actor,
            now,
          );
        }
        const allowlistMatch = /^\/allowlist\/([^/]+)$/.exec(route);
        if (allowlistMatch && request.method === "DELETE") {
          return await removeAllowlistSource(
            database,
            env,
            decodePathSegment(allowlistMatch[1]),
          );
        }
        return errorResponse(404, "Not found");
    }
  } catch {
    console.error("Admin API request failed");
    return errorResponse(500, "Admin request failed");
  }
}

export async function readRuntimeSettings(
  database: EventDatabase | undefined,
  installationId: string | undefined,
  fallback: RuntimeSettings = DEFAULT_RUNTIME_SETTINGS,
): Promise<RuntimeSettings> {
  if (!database || !installationId) return { ...fallback };
  try {
    const row = await database.prepare(
      `SELECT lures_enabled, maze_duration_minutes, block_duration_hours,
        response_budget, alert_grouping_minutes, retention_days
        FROM runtime_settings WHERE installation_id = ?`,
    ).bind(installationId).first<Record<string, number>>();
    if (!row) return { ...fallback };
    return mapRuntimeSettings(row, fallback);
  } catch {
    console.error("Runtime settings are unavailable; using configured defaults");
    return { ...fallback };
  }
}

export async function isRuntimeAllowlisted(
  database: EventDatabase | undefined,
  installationId: string | undefined,
  sourceIp: string,
): Promise<boolean> {
  if (!database || !installationId) return false;
  const result = await database.prepare(
    `SELECT 1 AS found FROM allowlisted_sources
      WHERE installation_id = ? AND source_ip = ? LIMIT 1`,
  ).bind(installationId, sourceIp).first<{ found: number }>();
  return result !== null;
}

export async function deleteExpiredAdminAudit(
  database: EventDatabase,
  now = Date.now(),
  retentionMs = 30 * DAY_MS,
): Promise<number> {
  const result = await database.prepare(
    "DELETE FROM admin_audit WHERE created_at <= ?",
  ).bind(now - Math.min(30 * DAY_MS, Math.max(1, retentionMs))).run();
  return result.meta?.changes ?? 0;
}

async function listAdminEvents(
  database: AdminDatabase,
  installationId: string,
  url: URL,
): Promise<Response> {
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 1, MAX_PAGE_SIZE);
  if (limit === null) return errorResponse(400, "Invalid page size");
  const confirmedValue = url.searchParams.get("confirmed");
  if (confirmedValue !== null && confirmedValue !== "true" && confirmedValue !== "false") {
    return errorResponse(400, "Invalid confirmation filter");
  }
  const cursorText = url.searchParams.get("cursor");
  const cursor = cursorText === null ? null : decodeCursor(cursorText);
  if (cursorText !== null && !cursor) return errorResponse(400, "Invalid page cursor");

  const confirmedClause = confirmedValue === null ? "" : "AND confirmed = ?";
  const cursorClause = cursor === null
    ? ""
    : "AND (created_at < ? OR (created_at = ? AND id < ?))";
  const values: unknown[] = [installationId];
  if (confirmedValue !== null) values.push(confirmedValue === "true" ? 1 : 0);
  if (cursor) values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  values.push(limit + 1);
  const result = await database.prepare(
    `SELECT id, installation_id, type, route, source_ip, confirmed, created_at
      FROM events WHERE installation_id = ? ${confirmedClause} ${cursorClause}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(...values).all<StoredEvent>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const events = rows.map(mapEvent);
  return jsonResponse({
    events,
    nextCursor: hasMore && rows.length
      ? encodeCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].id)
      : null,
  });
}

async function getAdminEvent(
  database: AdminDatabase,
  installationId: string,
  encodedId: string,
): Promise<Response> {
  const id = decodePathSegment(encodedId);
  if (!id || id.length > 128) return errorResponse(400, "Invalid event ID");
  const row = await database.prepare(
    `SELECT id, installation_id, type, route, source_ip, confirmed, created_at
      FROM events WHERE id = ? AND installation_id = ?`,
  ).bind(id, installationId).first<StoredEvent>();
  return row ? jsonResponse({ event: mapEvent(row) }) : errorResponse(404, "Event not found");
}

async function listActiveBlocks(
  database: AdminDatabase,
  env: Env,
  now: number,
): Promise<Response> {
  if (!env.AGENT_SESSIONS || !env.LURE_KEY_SECRET || !env.INSTALLATION_ID) {
    return errorResponse(503, "Containment state is unavailable");
  }
  const candidates = await database.prepare(
    `SELECT source_ip, MAX(created_at) AS created_at FROM events
      WHERE installation_id = ? AND confirmed = 1 AND source_ip IS NOT NULL
        AND created_at >= ?
      GROUP BY source_ip ORDER BY created_at DESC LIMIT ?`,
  ).bind(env.INSTALLATION_ID, now - 30 * DAY_MS, MAX_ACTIVE_SOURCE_CANDIDATES)
    .all<{ source_ip: string; created_at: number }>();

  const blocks: {
    sourceIp: string;
    mode: "maze" | "blocked";
    confirmedAt: number;
    expiresAt: number;
  }[] = [];
  for (const candidate of candidates.results) {
    const sourceIp = normalizeSourceIp(candidate.source_ip);
    if (!sourceIp) continue;
    const sessionName = await deriveAgentSessionName(
      env.INSTALLATION_ID,
      sourceIp,
      env.LURE_KEY_SECRET,
    );
    const snapshot = await env.AGENT_SESSIONS.get(
      env.AGENT_SESSIONS.idFromName(sessionName),
    ).getMode();
    const expiresAt = snapshot.mode === "maze"
      ? snapshot.mazeUntil
      : snapshot.mode === "blocked"
      ? snapshot.blockUntil
      : null;
    if (expiresAt !== null) {
      blocks.push({
        sourceIp,
        mode: snapshot.mode as "maze" | "blocked",
        confirmedAt: snapshot.confirmedAt ?? candidate.created_at,
        expiresAt,
      });
    }
  }
  return jsonResponse({ blocks });
}

async function updateRuntimeSettings(
  request: Request,
  database: AdminDatabase,
  env: Env,
): Promise<Response> {
  const input = await readJsonObject(request);
  if (!input) return errorResponse(400, "Invalid settings payload");
  const allowedFields = new Set([
    "luresEnabled",
    "mazeDurationMinutes",
    "blockDurationHours",
    "responseBudget",
    "alertGroupingMinutes",
    "retentionDays",
  ]);
  if (Object.keys(input).some((key) => !allowedFields.has(key))) {
    return errorResponse(400, "Unsupported setting");
  }
  const current = await readRuntimeSettings(database, env.INSTALLATION_ID);
  const merged: Record<string, unknown> = { ...current, ...input };
  const settings = validateRuntimeSettings(merged);
  if (!settings) return errorResponse(400, "Invalid runtime settings");

  await database.prepare(
    `INSERT INTO runtime_settings (
      installation_id, lures_enabled, maze_duration_minutes, block_duration_hours,
      response_budget, alert_grouping_minutes, retention_days
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(installation_id) DO UPDATE SET
      lures_enabled = excluded.lures_enabled,
      maze_duration_minutes = excluded.maze_duration_minutes,
      block_duration_hours = excluded.block_duration_hours,
      response_budget = excluded.response_budget,
      alert_grouping_minutes = excluded.alert_grouping_minutes,
      retention_days = excluded.retention_days`,
  ).bind(
    env.INSTALLATION_ID,
    settings.luresEnabled ? 1 : 0,
    settings.mazeDurationMinutes,
    settings.blockDurationHours,
    settings.responseBudget,
    settings.alertGroupingMinutes,
    settings.retentionDays,
  ).run();
  return jsonResponse(settings);
}

async function ensureRuntimeSettings(
  database: AdminDatabase,
  env: Env,
): Promise<RuntimeSettings> {
  const installationId = env.INSTALLATION_ID!;
  await database.prepare(
    "INSERT INTO runtime_settings (installation_id) VALUES (?) ON CONFLICT(installation_id) DO NOTHING",
  ).bind(installationId).run();
  const row = await database.prepare(
    `SELECT lures_enabled, maze_duration_minutes, block_duration_hours,
      response_budget, alert_grouping_minutes, retention_days
      FROM runtime_settings WHERE installation_id = ?`,
  ).bind(installationId).first<Record<string, number>>();
  return row ? mapRuntimeSettings(row) : { ...DEFAULT_RUNTIME_SETTINGS };
}

async function listAllowlist(
  database: AdminDatabase,
  env: Env,
): Promise<Response> {
  const result = await database.prepare(
    `SELECT source_ip FROM allowlisted_sources
      WHERE installation_id = ? ORDER BY source_ip`,
  ).bind(env.INSTALLATION_ID).all<{ source_ip: string }>();
  const configuredSources = (env.ALLOWLISTED_SOURCES ?? "")
    .split(",")
    .map((ip) => normalizeSourceIp(ip))
    .filter((ip): ip is string => ip !== null);
  return jsonResponse({
    sources: result.results.map((row) => row.source_ip),
    configuredSources,
  });
}

async function addAllowlistSource(
  request: Request,
  database: AdminDatabase,
  env: Env,
  actor: AdminActor,
  now: number,
): Promise<Response> {
  const input = await readJsonObject(request);
  const sourceIp = typeof input?.ip === "string" ? normalizeSourceIp(input.ip) : null;
  if (!sourceIp) return errorResponse(400, "Invalid IP address");
  await database.prepare(
    `INSERT INTO allowlisted_sources (installation_id, source_ip, actor_email, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(installation_id, source_ip) DO NOTHING`,
  ).bind(env.INSTALLATION_ID, sourceIp, actor.email, now).run();
  return jsonResponse({ ip: sourceIp }, 201);
}

async function removeAllowlistSource(
  database: AdminDatabase,
  env: Env,
  encodedIp: string,
): Promise<Response> {
  const sourceIp = normalizeSourceIp(decodePathSegment(encodedIp));
  if (!sourceIp) return errorResponse(400, "Invalid IP address");
  await database.prepare(
    "DELETE FROM allowlisted_sources WHERE installation_id = ? AND source_ip = ?",
  ).bind(env.INSTALLATION_ID, sourceIp).run();
  return new Response(null, {
    status: 204,
    headers: securityHeaders(),
  });
}

async function manuallyUnblock(
  database: AdminDatabase,
  env: Env,
  encodedIp: string,
  actor: AdminActor,
  now: number,
): Promise<Response> {
  const sourceIp = normalizeSourceIp(encodedIp);
  if (!sourceIp) return errorResponse(400, "Invalid IP address");
  if (!env.AGENT_SESSIONS || !env.LURE_KEY_SECRET || !env.INSTALLATION_ID) {
    return errorResponse(503, "Containment state is unavailable");
  }

  const auditId = crypto.randomUUID();
  await database.prepare(
    `INSERT INTO admin_audit (
      id, installation_id, actor_email, actor_subject, action, source_ip,
      created_at, outcome
    ) VALUES (?, ?, ?, ?, 'manual_unblock', ?, ?, 'pending')`,
  ).bind(
    auditId,
    env.INSTALLATION_ID,
    actor.email,
    actor.subject,
    sourceIp,
    now,
  ).run();

  try {
    const sessionName = await deriveAgentSessionName(
      env.INSTALLATION_ID,
      sourceIp,
      env.LURE_KEY_SECRET,
    );
    await env.AGENT_SESSIONS.get(
      env.AGENT_SESSIONS.idFromName(sessionName),
    ).unblock();
  } catch {
    await database.prepare(
      "UPDATE admin_audit SET outcome = 'failed' WHERE id = ? AND installation_id = ?",
    ).bind(auditId, env.INSTALLATION_ID).run();
    throw new Error("Manual unblock failed");
  }
  await database.prepare(
    "UPDATE admin_audit SET outcome = 'completed' WHERE id = ? AND installation_id = ?",
  ).bind(auditId, env.INSTALLATION_ID).run();
  return jsonResponse({ sourceIp, unblocked: true });
}

async function listAudit(
  database: AdminDatabase,
  env: Env,
  url: URL,
): Promise<Response> {
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 1, MAX_PAGE_SIZE);
  if (limit === null) return errorResponse(400, "Invalid page size");
  const result = await database.prepare(
    `SELECT id, actor_email, actor_subject, action, source_ip, created_at, outcome
      FROM admin_audit WHERE installation_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(env.INSTALLATION_ID, limit).all<Record<string, unknown>>();
  return jsonResponse({ entries: result.results });
}

function deploymentSettings(env: Env): Record<string, unknown> {
  let webhookHost: string | null = null;
  try {
    webhookHost = env.ALERT_WEBHOOK_URL
      ? new URL(env.ALERT_WEBHOOK_URL).hostname
      : null;
  } catch {
    webhookHost = null;
  }
  return {
    adminHostname: env.ADMIN_HOSTNAME ?? null,
    publicHostname: env.PUBLIC_SITE_HOSTNAME ?? null,
    adminRoute: env.ADMIN_ROUTE ?? null,
    publicRoute: env.PUBLIC_ROUTE ?? null,
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN ?? null,
    accessAudienceConfigured: Boolean(env.ACCESS_AUD),
    webhookDestinationHost: webhookHost,
    managedBy: "Terraform",
  };
}

function validateRuntimeSettings(value: Record<string, unknown>): RuntimeSettings | null {
  if (typeof value.luresEnabled !== "boolean") return null;
  const mazeDurationMinutes = boundedInteger(value.mazeDurationMinutes, 1, 120);
  const blockDurationHours = boundedInteger(value.blockDurationHours, 1, 168);
  const responseBudget = boundedInteger(value.responseBudget, 1, 10_000);
  const alertGroupingMinutes = boundedInteger(value.alertGroupingMinutes, 1, 60);
  const retentionDays = boundedInteger(value.retentionDays, 1, 30);
  if (
    mazeDurationMinutes === null
    || blockDurationHours === null
    || responseBudget === null
    || alertGroupingMinutes === null
    || retentionDays === null
  ) return null;
  return {
    luresEnabled: value.luresEnabled,
    mazeDurationMinutes,
    blockDurationHours,
    responseBudget,
    alertGroupingMinutes,
    retentionDays,
  };
}

function mapRuntimeSettings(
  row: Record<string, number>,
  fallback: RuntimeSettings = DEFAULT_RUNTIME_SETTINGS,
): RuntimeSettings {
  return {
    luresEnabled: row.lures_enabled === undefined
      ? fallback.luresEnabled
      : row.lures_enabled === 1,
    mazeDurationMinutes: row.maze_duration_minutes ?? fallback.mazeDurationMinutes,
    blockDurationHours: row.block_duration_hours ?? fallback.blockDurationHours,
    responseBudget: row.response_budget ?? fallback.responseBudget,
    alertGroupingMinutes: row.alert_grouping_minutes ?? fallback.alertGroupingMinutes,
    retentionDays: row.retention_days ?? fallback.retentionDays,
  };
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

function decodeCursor(value: string): { createdAt: number; id: string } | null {
  if (value.length > 512) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as {
      createdAt?: unknown;
      id?: unknown;
    };
    return typeof parsed.createdAt === "number"
        && Number.isSafeInteger(parsed.createdAt)
        && parsed.createdAt >= 0
        && typeof parsed.id === "string"
        && parsed.id.length > 0
        && parsed.id.length <= 128
      ? { createdAt: parsed.createdAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

function encodeCursor(createdAt: number, id: string): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify({ createdAt, id })));
}

function parseBoundedInteger(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === null) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  return boundedInteger(Number(value), min, max);
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === "number"
      && Number.isSafeInteger(value)
      && value >= min
      && value <= max
    ? value
    : null;
}

function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return Promise.resolve(null);
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return Promise.resolve(null);
  }
  return readBoundedBody(request).then((text) => {
    if (!text) return null;
    try {
      const value = JSON.parse(text);
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  });
}

async function readBoundedBody(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    const expected = new URL(request.url);
    const actual = new URL(origin);
    return expected.protocol === "https:"
      && actual.protocol === "https:"
      && actual.origin === expected.origin;
  } catch {
    return false;
  }
}

function isValidActor(actor: AdminActor): boolean {
  return typeof actor?.email === "string"
    && actor.email.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor.email)
    && typeof actor?.subject === "string"
    && actor.subject.length > 0
    && actor.subject.length <= 512;
}

function normalizeTeamDomain(value: string | undefined): string | null {
  if (!value) return null;
  const domain = value.trim().replace(/^https:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  return /^[a-z0-9.-]+$/.test(domain) && !domain.includes("..") ? domain : null;
}

function hasAudience(value: unknown, audience: string): boolean {
  return value === audience
    || Array.isArray(value) && value.some((entry) => entry === audience);
}

async function findAccessKey(
  certUrl: string,
  kid: string,
  fetcher: typeof fetch,
): Promise<JsonWebKey | null> {
  const now = Date.now();
  let cached = accessKeyCache.get(certUrl);
  if (!cached || cached.expiresAt <= now) {
    cached = await fetchAccessKeys(certUrl, fetcher);
    accessKeyCache.set(certUrl, cached);
  }
  let key = cached.keys.find((candidate) =>
    (candidate as JsonWebKey & { kid?: string }).kid === kid
  );
  if (!key) {
    accessKeyCache.delete(certUrl);
    cached = await fetchAccessKeys(certUrl, fetcher);
    accessKeyCache.set(certUrl, cached);
    key = cached.keys.find((candidate) =>
      (candidate as JsonWebKey & { kid?: string }).kid === kid
    );
  }
  return key ?? null;
}

async function fetchAccessKeys(
  certUrl: string,
  fetcher: typeof fetch,
): Promise<{ expiresAt: number; keys: JsonWebKey[] }> {
  const response = await fetcher(certUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Access signing keys unavailable");
  const value = await response.json() as { keys?: unknown };
  if (!Array.isArray(value.keys) || value.keys.length > 32) {
    throw new Error("Access signing keys unavailable");
  }
  return {
    expiresAt: Date.now() + ACCESS_CERT_CACHE_MS,
    keys: value.keys.filter((key): key is JsonWebKey =>
      key !== null && typeof key === "object"
    ),
  };
}

function parseJwtPart<T>(value: string): T {
  const decoded = new TextDecoder().decode(decodeBase64Url(value));
  const parsed = JSON.parse(decoded) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid Access identity");
  }
  return parsed as T;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoded value");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function securityHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      ...securityHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

function methodNotAllowed(): Response {
  return errorResponse(405, "Method not allowed");
}
