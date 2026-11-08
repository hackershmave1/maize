import { env as cloudflareEnv } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import worker, { type Env } from "../src";
import {
  deleteExpiredContainmentSources,
  handleAdminApiRequest,
  persistContainmentSource,
  validateAccessAssertion,
  type AdminActor,
} from "../src/admin-api";
import { deleteExpiredEvents, recordEvent, type EventDatabase } from "../src/events";
import { deriveAgentSessionName } from "../src/session-state";
import eventsSchema from "../migrations/0001_events.sql?raw";
import adminSchema from "../migrations/0002_admin.sql?raw";
import containmentSchema from "../migrations/0003_containment_sources.sql?raw";

const database = (cloudflareEnv as { EVENTS_DB: EventDatabase }).EVENTS_DB;
const installationId = "admin-api-test";
const actor: AdminActor = {
  email: "operator@example.test",
  subject: "access-subject-1",
};
const signingKeyId = "admin-api-test-key";
const audience = "admin-api-test-audience";
const teamDomain = "test-team.cloudflareaccess.com";
const assertionKeys = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", assertionKeys.publicKey);

beforeAll(async () => {
  for (const schema of [eventsSchema, adminSchema, containmentSchema]) {
    for (const statement of schema.split(";").map((part) => part.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
  await database.prepare("DELETE FROM admin_audit WHERE installation_id = ?")
    .bind(installationId).run();
  await database.prepare("DELETE FROM containment_sources WHERE installation_id = ?")
    .bind(installationId).run();
  await database.prepare("DELETE FROM allowlisted_sources WHERE installation_id = ?")
    .bind(installationId).run();
  await database.prepare("DELETE FROM webhook_outbox WHERE installation_id = ?")
    .bind(installationId).run();
  await database.prepare("DELETE FROM runtime_settings WHERE installation_id = ?")
    .bind(installationId).run();
  await database.prepare("DELETE FROM events WHERE installation_id = ?")
    .bind(installationId).run();
});

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(cloudflareEnv as unknown as Env),
    INSTALLATION_ID: installationId,
    ADMIN_HOSTNAME: "admin.example.test",
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUD: audience,
    ...overrides,
  } as Env;
}

function adminRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://admin.example.test/api/admin${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
      ...(init.method && init.method !== "GET"
        ? { Origin: "https://admin.example.test" }
        : {}),
    },
  });
}

function assertActorHeaders(token: string): HeadersInit {
  return { "Cf-Access-Jwt-Assertion": token };
}

async function signAssertion(
  claims: Record<string, unknown> = {},
  privateKey: CryptoKey = assertionKeys.privateKey,
): Promise<string> {
  const encode = (value: unknown) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const header = encode({ alg: "RS256", kid: signingKeyId, typ: "JWT" });
  const payload = encode({
    iss: `https://${teamDomain}`,
    aud: [audience],
    sub: actor.subject,
    email: actor.email,
    iat: Math.floor(Date.now() / 1_000),
    nbf: Math.floor(Date.now() / 1_000) - 5,
    exp: Math.floor(Date.now() / 1_000) + 300,
    ...claims,
  });
  const input = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(input),
  ));
  const encodedSignature = btoa(String.fromCharCode(...signature))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${input}.${encodedSignature}`;
}

function stubAccessCertificates(): void {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    keys: [{ ...publicJwk, kid: signingKeyId, alg: "RS256", use: "sig" }],
  })));
}

it("returns a stable cursor for event pagination and filters unconfirmed events", async () => {
  const now = 2_000_000_000_000;
  for (const [createdAt, confirmed] of [
    [now - 3, false],
    [now - 2, true],
    [now - 1, false],
  ] as const) {
    await recordEvent(database, {
      installationId,
      type: confirmed ? "confirmed_reuse" : "unconfirmed_lure_view",
      route: "env-file",
      sourceIp: "203.0.113.7",
      confirmed,
    }, createdAt);
  }

  const first = await handleAdminApiRequest(
    adminRequest("/events?limit=1&confirmed=false"),
    createEnv(),
    actor,
    now,
  );
  const firstBody = await first.json() as {
    events: { createdAt: number; confirmed: boolean }[];
    nextCursor: string | null;
  };
  expect(first.status).toBe(200);
  expect(firstBody.events).toHaveLength(1);
  expect(firstBody.events[0]).toMatchObject({ createdAt: now - 1, confirmed: false });
  expect(firstBody.nextCursor).toBeTruthy();

  const second = await handleAdminApiRequest(
    adminRequest(`/events?limit=1&confirmed=false&cursor=${encodeURIComponent(firstBody.nextCursor!)}`),
    createEnv(),
    actor,
    now,
  );
  const secondBody = await second.json() as typeof firstBody;
  expect(secondBody.events).toHaveLength(1);
  expect(secondBody.events[0]).toMatchObject({ createdAt: now - 3, confirmed: false });
  expect(secondBody.nextCursor).toBeNull();
});

it("filters confirmed event history without returning unconfirmed records", async () => {
  const response = await handleAdminApiRequest(
    adminRequest("/events?confirmed=true"),
    createEnv(),
    actor,
  );
  const body = await response.json() as {
    events: { confirmed: boolean }[];
  };

  expect(response.status).toBe(200);
  expect(body.events.length).toBeGreaterThan(0);
  expect(body.events.every((event) => event.confirmed)).toBe(true);
});

it("lists active maze and block states with their expiry", async () => {
  const sourceIp = "198.51.100.44";
  const mazeIp = "198.51.100.45";
  await recordEvent(database, {
    installationId,
    type: "confirmed_reuse",
    route: "bait-api",
    sourceIp,
    confirmed: true,
  });
  await recordEvent(database, {
    installationId,
    type: "confirmed_reuse",
    route: "bait-api",
    sourceIp: mazeIp,
    confirmed: true,
  });
  const sourceName = await deriveAgentSessionName(
    installationId,
    sourceIp,
    "test-state-secret",
  );
  const mazeName = await deriveAgentSessionName(
    installationId,
    mazeIp,
    "test-state-secret",
  );
  const retainUntil = Date.now() + 10 * 24 * 60 * 60 * 1_000;
  for (const [ip, confirmedAt] of [[sourceIp, 1_000], [mazeIp, 1_500]] as const) {
    await database.prepare(
      `INSERT INTO containment_sources (
        installation_id, source_ip, confirmed_at, retain_until
      ) VALUES (?, ?, ?, ?)`,
    ).bind(installationId, ip, confirmedAt, retainUntil).run();
  }
  const getMode = vi.fn(async () => ({
    mode: "blocked" as const,
    confirmedAt: 1_000,
    mazeUntil: 2_000,
    blockUntil: 3_000,
    mazeRequests: 0,
    throttledRequests: 0,
  }));
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((name: string) => ({
      getMode: name === mazeName
        ? vi.fn(async () => ({
          mode: "maze" as const,
          confirmedAt: 1_500,
          mazeUntil: 2_500,
          blockUntil: 3_500,
          mazeRequests: 0,
          throttledRequests: 0,
        }))
        : getMode,
      unblock: vi.fn(),
    })),
  };

  const response = await handleAdminApiRequest(
    adminRequest("/blocks"),
    createEnv({
      AGENT_SESSIONS: namespace as unknown as Env["AGENT_SESSIONS"],
      LURE_KEY_SECRET: "test-state-secret",
    }),
    actor,
  );
  const body = await response.json() as {
    blocks: { sourceIp: string; mode: string }[];
  };

  expect(response.status).toBe(200);
  expect(namespace.idFromName).toHaveBeenCalledWith(sourceName);
  expect(body.blocks).toContainEqual({
    sourceIp,
    mode: "blocked",
    confirmedAt: 1_000,
    expiresAt: 3_000,
  });
  expect(body.blocks).toContainEqual({
    sourceIp: mazeIp,
    mode: "maze",
    confirmedAt: 1_500,
    expiresAt: 2_500,
  });
});

it("keeps an active block discoverable after its event expires", async () => {
  const sourceIp = "198.51.100.61";
  const confirmedAt = Date.now();
  const blockUntil = confirmedAt + 5 * 24 * 60 * 60 * 1_000;
  let confirmed = false;
  const session = {
    getMode: vi.fn(async () => ({
      mode: confirmed ? "blocked" as const : "ordinary" as const,
      confirmedAt: confirmed ? confirmedAt : null,
      mazeUntil: confirmed ? confirmedAt + 24 * 60 * 60 * 1_000 : null,
      blockUntil: confirmed ? blockUntil : null,
      mazeRequests: 0,
      throttledRequests: 0,
    })),
    confirmKeyReuse: vi.fn(async () => {
      confirmed = true;
      return {
        mode: "maze" as const,
        confirmedAt,
        mazeUntil: confirmedAt + 24 * 60 * 60 * 1_000,
        blockUntil,
        mazeRequests: 0,
        throttledRequests: 0,
      };
    }),
    recordMazeRequest: vi.fn(),
    unblock: vi.fn(),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => session),
  };
  const env = createEnv({
    AGENT_SESSIONS: namespace as unknown as Env["AGENT_SESSIONS"],
    LURE_KEY_SECRET: "expired-event-index-secret",
    BAIT_API_PATH: "/api/private/account",
  });
  const lureResponse = await worker.fetch(
    new Request("https://site.example.test/.env", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    env,
  );
  const key = (await lureResponse.text()).match(/^API_KEY=(.+)$/m)?.[1];
  if (!key) throw new Error("The .env lure did not include a key");
  await worker.fetch(
    new Request("https://site.example.test/api/private/account", {
      headers: {
        Authorization: `Bearer ${key}`,
        "CF-Connecting-IP": sourceIp,
      },
    }),
    env,
  );
  await database.prepare(
    "UPDATE events SET created_at = ? WHERE installation_id = ? AND source_ip = ?",
  ).bind(confirmedAt - 2 * 24 * 60 * 60 * 1_000, installationId, sourceIp).run();
  expect(await deleteExpiredEvents(
    database,
    confirmedAt,
    24 * 60 * 60 * 1_000,
  )).toBeGreaterThan(0);
  const containment = await database.prepare(
    "SELECT retain_until FROM containment_sources WHERE installation_id = ? AND source_ip = ?",
  ).bind(installationId, sourceIp).first<{ retain_until: number }>();
  expect(containment?.retain_until).toBe(blockUntil);

  const response = await handleAdminApiRequest(
    adminRequest("/blocks"),
    env,
    actor,
    confirmedAt + 2 * 24 * 60 * 60 * 1_000,
  );
  const body = await response.json() as { blocks: { sourceIp: string }[] };

  expect(response.status).toBe(200);
  expect(body.blocks.some((block) => block.sourceIp === sourceIp)).toBe(true);
});

it("retains containment candidates through the maximum state lifetime and then expires them", async () => {
  const now = 2_000_000_000_000;
  const sourceIp = "198.51.100.62";
  const retentionInstallationId = `${installationId}-retention`;
  await persistContainmentSource(database, retentionInstallationId, sourceIp, now);
  const stored = await database.prepare(
    "SELECT confirmed_at, retain_until FROM containment_sources WHERE installation_id = ? AND source_ip = ?",
  ).bind(retentionInstallationId, sourceIp).first<{ confirmed_at: number; retain_until: number }>();

  expect(stored?.confirmed_at).toBe(now);
  expect(stored?.retain_until).toBeGreaterThan(now + 7 * 24 * 60 * 60 * 1_000);
  expect(await deleteExpiredContainmentSources(
    database,
    retentionInstallationId,
    now + 7 * 24 * 60 * 60 * 1_000,
  )).toBe(0);
  expect(await deleteExpiredContainmentSources(
    database,
    retentionInstallationId,
    stored!.retain_until,
  )).toBe(1);
});

it("paginates all active sources when there are more than one thousand candidates", async () => {
  const now = 2_000_000_000_000;
  await database.prepare(
    `WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 1005
    )
    INSERT INTO containment_sources (
      installation_id, source_ip, confirmed_at, retain_until
    )
    SELECT ?, printf('198.18.%d.%d', CAST((value - 1) / 256 AS INTEGER), (value - 1) % 256),
      ?, ? FROM sequence`,
  ).bind(installationId, now - 1_000, now + 60_000).run();
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({
      getMode: vi.fn(async () => ({
        mode: "blocked" as const,
        confirmedAt: now - 1_000,
        mazeUntil: now,
        blockUntil: now + 60_000,
        mazeRequests: 0,
        throttledRequests: 0,
      })),
      unblock: vi.fn(),
    })),
  };

  const retrieved: string[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await handleAdminApiRequest(
      adminRequest(`/blocks?${query}`),
      createEnv({
        AGENT_SESSIONS: namespace as unknown as Env["AGENT_SESSIONS"],
        LURE_KEY_SECRET: "pagination-state-secret",
      }),
      actor,
      now,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      blocks: { sourceIp: string }[];
      nextCursor: string | null;
    };
    retrieved.push(...body.blocks.map((block) => block.sourceIp));
    cursor = body.nextCursor;
  } while (cursor);

  expect(retrieved).toHaveLength(1005);
  expect(new Set(retrieved).size).toBe(1005);
  expect(namespace.get).toHaveBeenCalledTimes(1005);
});

it("validates and persists bounded runtime settings", async () => {
  const invalid = await handleAdminApiRequest(
    adminRequest("/settings", {
      method: "PUT",
      body: JSON.stringify({ responseBudget: 1_000_000 }),
    }),
    createEnv(),
    actor,
  );
  expect(invalid.status).toBe(400);

  const valid = await handleAdminApiRequest(
    adminRequest("/settings", {
      method: "PUT",
      body: JSON.stringify({
        luresEnabled: false,
        mazeDurationMinutes: 10,
        blockDurationHours: 12,
        responseBudget: 250,
        alertGroupingMinutes: 3,
        retentionDays: 14,
      }),
    }),
    createEnv(),
    actor,
  );
  expect(valid.status).toBe(200);
  expect(await valid.json()).toMatchObject({
    luresEnabled: false,
    mazeDurationMinutes: 10,
    blockDurationHours: 12,
    responseBudget: 250,
    alertGroupingMinutes: 3,
    retentionDays: 14,
  });
});

it("keeps Terraform-managed webhook secrets out of the settings response", async () => {
  const response = await handleAdminApiRequest(
    adminRequest("/settings"),
    createEnv({
      ALERT_WEBHOOK_URL: "https://hooks.example.test/receive?token=webhook-secret-sentinel",
    }),
    actor,
  );
  const body = await response.text();

  expect(body).toContain("hooks.example.test");
  expect(body).not.toContain("webhook-secret-sentinel");
  expect(body).not.toContain("/receive");
});

it("adds and removes normalized allowlist addresses", async () => {
  const add = await handleAdminApiRequest(
    adminRequest("/allowlist", {
      method: "POST",
      body: JSON.stringify({ ip: " 203.0.113.8 " }),
    }),
    createEnv(),
    actor,
  );
  expect(add.status).toBe(201);
  expect(await add.json()).toMatchObject({ ip: "203.0.113.8" });

  const list = await handleAdminApiRequest(
    adminRequest("/allowlist"),
    createEnv(),
    actor,
  );
  expect(await list.json()).toMatchObject({ sources: ["203.0.113.8"] });

  const remove = await handleAdminApiRequest(
    adminRequest("/allowlist/203.0.113.8", { method: "DELETE" }),
    createEnv(),
    actor,
  );
  expect(remove.status).toBe(204);
});

it("rejects cross-origin runtime mutations", async () => {
  const response = await handleAdminApiRequest(
    new Request("https://admin.example.test/api/admin/allowlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example.test",
      },
      body: JSON.stringify({ ip: "203.0.113.31" }),
    }),
    createEnv(),
    actor,
  );

  expect(response.status).toBe(403);
});

it("applies runtime allowlist additions to Worker traffic", async () => {
  const sourceIp = "203.0.113.18";
  await handleAdminApiRequest(
    adminRequest("/allowlist", {
      method: "POST",
      body: JSON.stringify({ ip: sourceIp }),
    }),
    createEnv(),
    actor,
  );
  const originFetch = vi.fn(async () => new Response("origin"));
  const getMode = vi.fn();
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ getMode, unblock: vi.fn() })),
  };
  const response = await worker.fetch(
    new Request("https://site.example.test/home", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    createEnv({
      ORIGIN: { fetch: originFetch },
      AGENT_SESSIONS: namespace as unknown as Env["AGENT_SESSIONS"],
    }),
  );

  expect(response.status).toBe(200);
  expect(originFetch).toHaveBeenCalledOnce();
  expect(namespace.get).not.toHaveBeenCalled();
});

it("does not return a lure after the runtime lure switch is disabled", async () => {
  await handleAdminApiRequest(
    adminRequest("/settings", {
      method: "PUT",
      body: JSON.stringify({
        luresEnabled: false,
        mazeDurationMinutes: 15,
        blockDurationHours: 24,
        responseBudget: 100,
        alertGroupingMinutes: 5,
        retentionDays: 30,
      }),
    }),
    createEnv(),
    actor,
  );
  const originFetch = vi.fn(async () => new Response("origin"));
  const response = await worker.fetch(
    new Request("https://site.example.test/.env", {
      headers: { "CF-Connecting-IP": "203.0.113.19" },
    }),
    createEnv({
      ORIGIN: { fetch: originFetch },
      LURE_KEY_SECRET: "test-lure-secret",
      BAIT_API_PATH: "/api/private/account",
    }),
  );

  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("API_KEY=");
  expect(originFetch).not.toHaveBeenCalled();
});

it("uses the stored response budget for active maze traffic", async () => {
  await handleAdminApiRequest(
    adminRequest("/settings", {
      method: "PUT",
      body: JSON.stringify({
        luresEnabled: true,
        mazeDurationMinutes: 10,
        blockDurationHours: 12,
        responseBudget: 17,
        alertGroupingMinutes: 3,
        retentionDays: 14,
      }),
    }),
    createEnv(),
    actor,
  );
  const session = {
    getMode: vi.fn(async () => ({
      mode: "maze" as const,
      confirmedAt: 1_000,
      mazeUntil: 2_000,
      blockUntil: 3_000,
      mazeRequests: 0,
      throttledRequests: 0,
    })),
    confirmKeyReuse: vi.fn(),
    recordMazeRequest: vi.fn(async () => ({
      state: {
        mode: "maze" as const,
        confirmedAt: 1_000,
        mazeUntil: 2_000,
        blockUntil: 3_000,
        mazeRequests: 17,
        throttledRequests: 0,
      },
      throttled: false,
    })),
    unblock: vi.fn(),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => session),
  };
  const response = await worker.fetch(
    new Request("https://site.example.test/private", {
      headers: { "CF-Connecting-IP": "203.0.113.20" },
    }),
    createEnv({
      LURE_KEY_SECRET: "runtime-controls-test-secret",
      AGENT_SESSIONS: namespace as unknown as Env["AGENT_SESSIONS"],
    }),
  );

  expect(response.status).toBe(404);
  expect(session.recordMazeRequest).toHaveBeenCalledWith(17);
});

it("applies configured maze and block durations on confirmed key reuse", async () => {
  await handleAdminApiRequest(
    adminRequest("/settings", {
      method: "PUT",
      body: JSON.stringify({
        luresEnabled: true,
        mazeDurationMinutes: 7,
        blockDurationHours: 9,
        responseBudget: 100,
        alertGroupingMinutes: 5,
        retentionDays: 30,
      }),
    }),
    createEnv(),
    actor,
  );
  const session = {
    getMode: vi.fn(async () => ({
      mode: "ordinary" as const,
      confirmedAt: null,
      mazeUntil: null,
      blockUntil: null,
      mazeRequests: 0,
      throttledRequests: 0,
    })),
    confirmKeyReuse: vi.fn(),
    recordMazeRequest: vi.fn(),
    unblock: vi.fn(),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => session),
  };
  const env = createEnv({
    AGENT_SESSIONS: namespace as unknown as Env["AGENT_SESSIONS"],
    LURE_KEY_SECRET: "duration-test-secret",
    BAIT_API_PATH: "/api/private/account",
  });
  const lure = await worker.fetch(
    new Request("https://site.example.test/.env", {
      headers: { "CF-Connecting-IP": "203.0.113.21" },
    }),
    env,
  );
  const key = (await lure.text()).match(/^API_KEY=(.+)$/m)?.[1];
  if (!key) throw new Error("The .env lure did not include a key");

  await worker.fetch(
    new Request("https://site.example.test/api/private/account", {
      headers: {
        Authorization: `Bearer ${key}`,
        "CF-Connecting-IP": "203.0.113.21",
      },
    }),
    env,
  );

  expect(session.confirmKeyReuse).toHaveBeenCalledWith(7 * 60_000, 9 * 60 * 60_000);
});

it("unblocks through the source Durable Object and audits the actor and time", async () => {
  const sourceIp = "203.0.113.9";
  const unblock = vi.fn(async () => ({
    mode: "ordinary" as const,
    confirmedAt: null,
    mazeUntil: null,
    blockUntil: null,
    mazeRequests: 0,
    throttledRequests: 0,
  }));
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ getMode: vi.fn(), unblock })),
  };
  const now = 1_700_000_000_123;
  const response = await handleAdminApiRequest(
    adminRequest(`/blocks/${sourceIp}/unblock`, { method: "POST" }),
    createEnv({
      AGENT_SESSIONS: namespace as unknown as Env["AGENT_SESSIONS"],
      LURE_KEY_SECRET: "test-state-secret",
    }),
    actor,
    now,
  );
  const audit = await database.prepare(
    `SELECT actor_email, actor_subject, action, source_ip, created_at, outcome
      FROM admin_audit WHERE installation_id = ? AND source_ip = ?`,
  ).bind(installationId, sourceIp).first<Record<string, unknown>>();

  expect(response.status).toBe(200);
  expect(unblock).toHaveBeenCalledOnce();
  expect(namespace.idFromName).toHaveBeenCalledOnce();
  expect(audit).toEqual({
    actor_email: actor.email,
    actor_subject: actor.subject,
    action: "manual_unblock",
    source_ip: sourceIp,
    created_at: now,
    outcome: "completed",
  });
});

it("rejects missing and invalid Access identities at the Worker boundary", async () => {
  const env = createEnv();
  const missing = await worker.fetch(
    new Request("https://admin.example.test/api/admin/events"),
    env,
  );
  const invalid = await worker.fetch(
    new Request("https://admin.example.test/api/admin/events", {
      headers: assertActorHeaders("not-a-jwt"),
    }),
    env,
  );

  expect(missing.status).toBe(401);
  expect(invalid.status).toBe(401);
});

it("does not expose admin APIs through an alternate workers.dev hostname", async () => {
  const originFetch = vi.fn(async () => new Response("origin"));
  const env = createEnv({
    ORIGIN: { fetch: originFetch },
    PUBLIC_SITE_HOSTNAME: "site.example.test",
  });
  const responses = await Promise.all([
    worker.fetch(
      new Request("https://moqesh-cloudflare.account.workers.dev/api/admin/events", {
        headers: assertActorHeaders("not-a-jwt"),
      }),
      env,
    ),
    worker.fetch(
      new Request("https://site.example.test/api/admin/events", {
        headers: assertActorHeaders("not-a-jwt"),
      }),
      env,
    ),
  ]);

  expect(responses.map((response) => response.status)).toEqual([404, 404]);
  expect(originFetch).not.toHaveBeenCalled();
});

it("verifies the Access issuer, audience, expiry, and RSA signature", async () => {
  const token = await signAssertion();
  const assertionRequest = new Request("https://admin.example.test/", {
    headers: assertActorHeaders(token),
  });
  const fetcher = vi.fn(async () => Response.json({
    keys: [{ ...publicJwk, kid: signingKeyId, alg: "RS256", use: "sig" }],
  }));

  await expect(validateAccessAssertion(assertionRequest, createEnv(), fetcher))
    .resolves.toEqual(actor);
  await expect(validateAccessAssertion(
    new Request("https://admin.example.test/", {
      headers: assertActorHeaders(await signAssertion({ aud: "wrong-audience" })),
    }),
    createEnv(),
    fetcher,
  )).rejects.toThrow();
  await expect(validateAccessAssertion(
    new Request("https://admin.example.test/", {
      headers: assertActorHeaders(await signAssertion({ exp: 1 })),
    }),
    createEnv(),
    fetcher,
  )).rejects.toThrow();
  const otherKeys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  await expect(validateAccessAssertion(
    new Request("https://admin.example.test/", {
      headers: assertActorHeaders(await signAssertion({}, otherKeys.privateKey)),
    }),
    createEnv(),
    fetcher,
  )).rejects.toThrow();
});

it("authenticates signed Access assertions before serving dashboard requests", async () => {
  const token = await signAssertion();
  stubAccessCertificates();
  const response = await worker.fetch(
    new Request("https://admin.example.test/", {
      headers: assertActorHeaders(token),
    }),
    createEnv({
      ASSETS: { fetch: async () => new Response("dashboard-shell") },
    } as Partial<Env>),
  );

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("dashboard-shell");
  expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

it("accepts a signed Access assertion for an authorized admin API request", async () => {
  const workerTeamDomain = "worker-team.cloudflareaccess.com";
  const token = await signAssertion({
    iss: `https://${workerTeamDomain}`,
  });
  stubAccessCertificates();
  const response = await worker.fetch(
    new Request("https://admin.example.test/api/admin/events", {
      headers: assertActorHeaders(token),
    }),
    createEnv({ ACCESS_TEAM_DOMAIN: workerTeamDomain }),
  );

  expect(response.status).toBe(200);
  const body = await response.json() as { events: unknown[]; nextCursor: unknown };
  expect(Array.isArray(body.events)).toBe(true);
  expect(body).toHaveProperty("nextCursor");
});
