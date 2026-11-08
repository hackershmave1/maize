import { env as cloudflareEnv, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  deliverOutbox,
  enqueueAlert,
  enqueueAlertWithEvent,
  processPendingAlerts,
} from "../src/alerts";
import worker, { type Env } from "../src";
import {
  recordEvent,
  type EventDatabase,
  type EventRecord,
} from "../src/events";
import type { LureAlert } from "../src/lures";
import schema from "../migrations/0001_events.sql?raw";

const database = (cloudflareEnv as { EVENTS_DB: EventDatabase }).EVENTS_DB;
const installationId = "alerts-test-installation";
const sourceIp = "203.0.113.42";
const minute = 60_000;

async function clearTestRows(): Promise<void> {
  await database.prepare("DELETE FROM webhook_outbox WHERE installation_id = ?")
    .bind(installationId).run();
  await database.prepare("DELETE FROM runtime_settings WHERE installation_id = ?")
    .bind(installationId).run();
  await database.prepare("DELETE FROM events WHERE installation_id = ?")
    .bind(installationId).run();
}

async function createAlertEvent(now: number): Promise<EventRecord> {
  return recordEvent(database, {
    installationId,
    type: "confirmed_reuse",
    route: "bait-api",
    sourceIp,
    confirmed: true,
  }, now);
}

const confirmation: LureAlert = {
  type: "confirmation",
  route: "bait-api",
  source: sourceIp,
};

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ORIGIN: { fetch: async () => new Response("origin-ok") },
    EVENTS_DB: database,
    INSTALLATION_ID: installationId,
    LURE_KEY_SECRET: "test-verifier-material",
    BAIT_API_PATH: "/api/private/account",
    ALERT_WEBHOOK_URL: "https://hooks.test/moqesh",
    ...overrides,
  };
}

beforeAll(async () => {
  for (const statement of schema.split(";").map((part) => part.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
});

beforeEach(async () => {
  await clearTestRows();
});

it("persists and immediately dispatches a confirmed lure alert without delaying its response", async () => {
  const env = testEnv({
    ALLOWLISTED_SOURCES: sourceIp,
    ALERT_CONFIRMATION: "true",
  });
  const lureResponse = await worker.fetch(
    new Request("https://site.test/.env"),
    env,
  );
  const key = (await lureResponse.text()).match(/^API_KEY=(.+)$/m)?.[1];
  if (!key) throw new Error("The .env lure did not include its synthetic key");

  let releaseDelivery!: (response: Response) => void;
  const delivery = new Promise<Response>((resolve) => {
    releaseDelivery = resolve;
  });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => delivery);
  vi.stubGlobal("fetch", fetchMock);
  const context = createExecutionContext();

  try {
    const response = await worker.fetch(
      new Request(`https://site.test/api/private/account?query=query-sentinel`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          Cookie: "cookie-sentinel",
          "CF-Connecting-IP": sourceIp,
          "Content-Type": "text/plain",
        },
        body: "request-body-sentinel",
      }),
      env,
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"readonly":true');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const queued = await database.prepare(
      "SELECT id, status, next_attempt_at FROM webhook_outbox WHERE installation_id = ?",
    ).bind(installationId).all();
    expect(queued.results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://hooks.test/moqesh");
    const headers = new Headers(init?.headers);
    expect(headers.get("Idempotency-Key")).toBeTruthy();
    const payload = String(init?.body);
    expect(payload).toContain('"type":"confirmation"');
    expect(payload).toContain(sourceIp);
    expect(payload).not.toContain(key);
    for (const secret of [
      "query-sentinel",
      "cookie-sentinel",
      "request-body-sentinel",
    ]) {
      expect(payload).not.toContain(secret);
    }

    const stored = JSON.stringify(await database.prepare(
      `SELECT * FROM events WHERE installation_id = ?`,
    ).bind(installationId).all());
    expect(stored).toContain("confirmed_reuse");
    expect(stored).not.toContain(key);
    expect(stored).not.toContain("cookie-sentinel");
    expect(stored).not.toContain("request-body-sentinel");
    expect(stored).not.toContain("query-sentinel");
  } finally {
    releaseDelivery(new Response("accepted", { status: 202 }));
    await waitOnExecutionContext(context);
    vi.unstubAllGlobals();
  }
});

it("sends the first alert immediately and groups later events into one five-minute delivery", async () => {
  const start = 2_000_000_000_000;
  const first = await createAlertEvent(start);
  const immediate = await enqueueAlert(database, first, confirmation, start);
  expect(immediate.dispatchImmediately).toBe(true);
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("accepted", { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await expect(deliverOutbox(
      database,
      immediate.outboxId,
      "https://hooks.test/moqesh",
      start,
    )).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    const second = await createAlertEvent(start + minute);
    const secondGroup = await enqueueAlert(database, second, confirmation, start + minute);
    const third = await createAlertEvent(start + 2 * minute);
    const thirdGroup = await enqueueAlert(database, third, confirmation, start + 2 * minute);

    expect(secondGroup.dispatchImmediately).toBe(false);
    expect(thirdGroup.outboxId).toBe(secondGroup.outboxId);
    expect(thirdGroup.dispatchImmediately).toBe(false);
    const row = await database.prepare(
      "SELECT event_ids_json, next_attempt_at FROM webhook_outbox WHERE id = ?",
    ).bind(secondGroup.outboxId).first<{
      event_ids_json: string;
      next_attempt_at: number;
    }>();
    expect(JSON.parse(row?.event_ids_json ?? "[]")).toEqual([second.id, third.id]);
    expect(row?.next_attempt_at).toBe(start + 5 * minute);

    await expect(processPendingAlerts(
      database,
      "https://hooks.test/moqesh",
      start + 5 * minute - 1,
    )).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();

    await expect(processPendingAlerts(
      database,
      "https://hooks.test/moqesh",
      start + 5 * minute,
    )).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const groupedPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(groupedPayload.alerts).toHaveLength(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does not leave an alert event persisted when its outbox transaction fails", async () => {
  const failingDatabase = {
    prepare: database.prepare.bind(database),
    batch: async () => {
      throw new Error("outbox transaction failed");
    },
  };

  await expect(enqueueAlertWithEvent(
    failingDatabase,
    {
      installationId,
      type: "confirmed_reuse",
      route: "bait-api",
      sourceIp,
      confirmed: true,
    },
    confirmation,
    2_000_000_000_000,
  )).rejects.toThrow("outbox transaction failed");

  const rows = await database.prepare(
    "SELECT id FROM events WHERE installation_id = ? AND type = 'confirmed_reuse'",
  ).bind(installationId).all();
  expect(rows.results).toHaveLength(0);
});

it("retains failed delivery and retries with the same idempotency key only until success", async () => {
  const now = 2_000_000_000_000;
  const event = await createAlertEvent(now);
  const queued = await enqueueAlert(database, event, confirmation, now);
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    .mockResolvedValueOnce(new Response("accepted", { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);

  try {
    await expect(processPendingAlerts(
      database,
      "https://hooks.test/moqesh",
      now,
    )).resolves.toBe(1);
    const failed = await database.prepare(
      "SELECT status, attempts, next_attempt_at FROM webhook_outbox WHERE id = ?",
    ).bind(queued.outboxId).first<{
      status: string;
      attempts: number;
      next_attempt_at: number;
    }>();
    expect(failed).toMatchObject({
      status: "pending",
      attempts: 1,
      next_attempt_at: now + 30_000,
    });

    await expect(processPendingAlerts(
      database,
      "https://hooks.test/moqesh",
      now + 30_000,
    )).resolves.toBe(1);
    const delivered = await database.prepare(
      "SELECT status, attempts FROM webhook_outbox WHERE id = ?",
    ).bind(queued.outboxId).first<{ status: string; attempts: number }>();
    expect(delivered).toEqual({ status: "delivered", attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const retryHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(retryHeaders.get("Idempotency-Key")).toBe(
      firstHeaders.get("Idempotency-Key"),
    );

    await expect(processPendingAlerts(
      database,
      "https://hooks.test/moqesh",
      now + 60_000,
    )).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does not deliver to a non-HTTPS webhook destination", async () => {
  const now = 2_000_000_000_000;
  const event = await createAlertEvent(now);
  const queued = await enqueueAlert(database, event, confirmation, now);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  try {
    await expect(processPendingAlerts(database, "http://hooks.test/moqesh", now))
      .resolves.toBe(1);
    const outbox = await database.prepare(
      "SELECT status, attempts FROM webhook_outbox WHERE id = ?",
    ).bind(queued.outboxId).first<{ status: string; attempts: number }>();
    expect(outbox).toMatchObject({ status: "pending", attempts: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps the lure response when D1 persistence fails and reports the failure", async () => {
  const run = vi.fn(async () => {
    throw new Error("storage unavailable");
  });
  const brokenDatabase = {
    prepare: vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        return this;
      }),
      run,
      all: vi.fn(),
      first: vi.fn(),
    })),
  } as unknown as EventDatabase;
  const env = testEnv({ EVENTS_DB: brokenDatabase });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  try {
    const response = await worker.fetch(new Request("https://site.test/.env"), env);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toMatch(/^API_KEY=[a-f0-9]{64}$/m);
    expect(error).toHaveBeenCalledWith(
      "D1 event persistence failed; preserving the existing Worker response",
    );
  } finally {
    error.mockRestore();
  }
});

it("does not persist ordinary requests", async () => {
  const env = testEnv({ ALLOWLISTED_SOURCES: sourceIp });
  const response = await worker.fetch(
    new Request("https://site.test/home?private=query-sentinel", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    env,
  );

  expect(await response.text()).toBe("origin-ok");
  expect(await database.prepare(
    "SELECT id FROM events WHERE installation_id = ?",
  ).bind(installationId).all()).toMatchObject({ results: [] });
});

it("uses the scheduled handler to retry pending webhook deliveries", async () => {
  const event = await createAlertEvent(Date.now());
  const queued = await enqueueAlert(database, event, confirmation);
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("accepted", { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  const context = createExecutionContext();

  try {
    await worker.scheduled!(
      { scheduledTime: Date.now(), cron: "* * * * *" },
      testEnv(),
      context,
    );
    await waitOnExecutionContext(context);

    const row = await database.prepare(
      "SELECT status FROM webhook_outbox WHERE id = ?",
    ).bind(queued.outboxId).first<{ status: string }>();
    expect(row?.status).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
