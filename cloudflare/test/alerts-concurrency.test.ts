import { env as cloudflareEnv } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  ALERT_MAX_ATTEMPTS,
  backoffForAttempt,
  deliverOutbox,
  enqueueAlert,
  processPendingAlerts,
} from "../src/alerts";
import { recordEvent, type EventDatabase } from "../src/events";
import type { LureAlert } from "../src/lures";
import schema from "../migrations/0001_events.sql?raw";

const database = (cloudflareEnv as { EVENTS_DB: EventDatabase }).EVENTS_DB;
const installationId = "alerts-concurrency-installation";
const now = 2_000_000_000_000;
const minute = 60_000;
const confirmation: LureAlert = {
  type: "confirmation",
  route: "bait-api",
  source: "203.0.113.42",
};

function createEvent(time = now, index = 42, installation = installationId) {
  return recordEvent(database, {
    installationId: installation,
    type: "confirmed_reuse",
    route: "bait-api",
    sourceIp: `203.0.113.${index}`,
    confirmed: true,
  }, time);
}

beforeAll(async () => {
  for (const statement of schema.split(";").map((part) => part.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
});

beforeEach(async () => {
  for (const table of ["webhook_outbox", "runtime_settings", "events"]) {
    await database.prepare(`DELETE FROM ${table} WHERE installation_id LIKE ?`)
      .bind(`${installationId}%`).run();
  }
});

it("does not lose concurrent appends racing a local D1 delivery claim", async () => {
  const first = await createEvent();
  const initial = await enqueueAlert(database, first, confirmation, now);
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("accepted", { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);

  try {
    await deliverOutbox(database, initial.outboxId, "https://hooks.test/moqesh", now);
    const seed = await createEvent(now + minute);
    const pending = await enqueueAlert(database, seed, confirmation, now + minute);
    const events = await Promise.all(Array.from({ length: 12 }, () => createEvent(now + 5 * minute)));
    await Promise.all([
      deliverOutbox(database, pending.outboxId, "https://hooks.test/moqesh", now + 5 * minute),
      ...events.map((event) => enqueueAlert(database, event, confirmation, now + 5 * minute)),
    ]);
    await processPendingAlerts(database, "https://hooks.test/moqesh", now + 5 * minute);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await processPendingAlerts(database, "https://hooks.test/moqesh", now + 10 * minute);
    const expectedIds = [first.id, seed.id, ...events.map((event) => event.id)].sort();
    const deliveredIds = fetchMock.mock.calls.flatMap(([, init]) =>
      JSON.parse(String(init?.body)).alerts.map((item: { eventId: string }) => item.eventId));
    expect(deliveredIds.sort()).toEqual(expectedIds);
    const rows = await database.prepare(
      "SELECT event_ids_json, status FROM webhook_outbox WHERE installation_id = ?",
    ).bind(installationId).all<{ event_ids_json: string; status: string }>();
    expect(rows.results.every((row) => row.status === "delivered")).toBe(true);
    expect(rows.results.flatMap((row) => JSON.parse(row.event_ids_json)).sort()).toEqual(expectedIds);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does not block another installation while a claimed group is sending", async () => {
  const event = await createEvent();
  const initial = await enqueueAlert(database, event, confirmation, now);
  let release!: (response: Response) => void;
  const delayed = new Promise<Response>((resolve) => { release = resolve; });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    return payload.alerts.some((item: { eventId: string }) => item.eventId === event.id)
      ? delayed
      : new Response("accepted", { status: 202 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const delivery = deliverOutbox(database, initial.outboxId, "https://hooks.test/moqesh", now);

  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const events = await Promise.all(Array.from({ length: 12 }, () => createEvent(now + minute)));
    const independent = await createEvent(now + minute, 100, `${installationId}-independent`);
    const [queued, other] = await Promise.all([
      Promise.all(events.map((item) => enqueueAlert(database, item, confirmation, now + minute))),
      enqueueAlert(database, independent, confirmation, now + minute),
    ]);
    expect(new Set(queued.map((item) => item.outboxId)).size).toBe(1);
    expect(queued.every((item) => !item.dispatchImmediately)).toBe(true);
    expect(other.dispatchImmediately).toBe(true);
    await expect(deliverOutbox(database, other.outboxId, "https://hooks.test/moqesh", now + minute))
      .resolves.toBe(true);
    release(new Response("accepted", { status: 202 }));
    await delivery;
    await expect(processPendingAlerts(database, "https://hooks.test/moqesh", now + 5 * minute - 1))
      .resolves.toBe(0);
    await Promise.all(Array.from({ length: 6 }, () =>
      processPendingAlerts(database, "https://hooks.test/moqesh", now + 5 * minute)));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const deliveredIds = fetchMock.mock.calls.flatMap(([, init]) =>
      JSON.parse(String(init?.body)).alerts.map((item: { eventId: string }) => item.eventId));
    expect(deliveredIds.sort()).toEqual([event.id, independent.id, ...events.map((item) => item.id)].sort());
  } finally {
    release(new Response("accepted", { status: 202 }));
    await delivery;
    vi.unstubAllGlobals();
  }
});

it("keeps concurrent retries bounded with the original idempotency key", async () => {
  const event = await createEvent();
  const queued = await enqueueAlert(database, event, confirmation, now);
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("unavailable", { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  try {
    let retryAt = now;
    for (let attempt = 1; attempt <= ALERT_MAX_ATTEMPTS; attempt++) {
      await Promise.all(Array.from({ length: 6 }, () =>
        processPendingAlerts(database, "https://hooks.test/moqesh", retryAt)));
      expect(fetchMock).toHaveBeenCalledTimes(attempt);
      retryAt += backoffForAttempt(attempt);
    }
    await processPendingAlerts(database, "https://hooks.test/moqesh", retryAt);
    expect(fetchMock).toHaveBeenCalledTimes(ALERT_MAX_ATTEMPTS);
    const row = await database.prepare(
      "SELECT status, attempts, idempotency_key, event_ids_json FROM webhook_outbox WHERE id = ?",
    ).bind(queued.outboxId).first<{
      status: string; attempts: number; idempotency_key: string; event_ids_json: string;
    }>();
    expect(row).toMatchObject({ status: "dead", attempts: ALERT_MAX_ATTEMPTS });
    expect(JSON.parse(row!.event_ids_json)).toEqual([event.id]);
    expect(fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("Idempotency-Key")))
      .toEqual(Array(ALERT_MAX_ATTEMPTS).fill(row!.idempotency_key));
  } finally {
    error.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("marks a stale sending row at the attempt cap dead without retrying it", async () => {
  const event = await createEvent();
  const queued = await enqueueAlert(database, event, confirmation, now);
  await database.prepare(
    `UPDATE webhook_outbox
      SET status = 'sending', attempts = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(ALERT_MAX_ATTEMPTS, now - minute, queued.outboxId).run();
  await database.prepare(
    "UPDATE runtime_settings SET pending_outbox_id = ? WHERE installation_id = ?",
  ).bind(queued.outboxId, installationId).run();
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("accepted", { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);

  try {
    await expect(processPendingAlerts(database, "https://hooks.test/moqesh", now))
      .resolves.toBe(0);
    const row = await database.prepare(
      `SELECT status, attempts FROM webhook_outbox WHERE id = ?`,
    ).bind(queued.outboxId).first<{ status: string; attempts: number }>();
    const settings = await database.prepare(
      "SELECT pending_outbox_id FROM runtime_settings WHERE installation_id = ?",
    ).bind(installationId).first<{ pending_outbox_id: string | null }>();
    expect(row).toEqual({ status: "dead", attempts: ALERT_MAX_ATTEMPTS });
    expect(settings?.pending_outbox_id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(processPendingAlerts(
      database,
      "https://hooks.test/moqesh",
      now + minute,
    )).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("marks a pending row at the attempt cap dead before scheduling it", async () => {
  const event = await createEvent();
  const queued = await enqueueAlert(database, event, confirmation, now);
  await database.prepare(
    `UPDATE webhook_outbox
      SET attempts = ?, next_attempt_at = ?
      WHERE id = ?`,
  ).bind(ALERT_MAX_ATTEMPTS, now, queued.outboxId).run();
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("accepted", { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);

  try {
    await expect(processPendingAlerts(database, "https://hooks.test/moqesh", now))
      .resolves.toBe(0);
    const row = await database.prepare(
      "SELECT status, attempts FROM webhook_outbox WHERE id = ?",
    ).bind(queued.outboxId).first<{ status: string; attempts: number }>();
    expect(row).toEqual({ status: "dead", attempts: ALERT_MAX_ATTEMPTS });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(processPendingAlerts(
      database,
      "https://hooks.test/moqesh",
      now + minute,
    )).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does not claim a pending row at the attempt cap when called directly", async () => {
  const event = await createEvent();
  const queued = await enqueueAlert(database, event, confirmation, now);
  await database.prepare(
    "UPDATE webhook_outbox SET attempts = ? WHERE id = ?",
  ).bind(ALERT_MAX_ATTEMPTS, queued.outboxId).run();
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("accepted", { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);

  try {
    await expect(deliverOutbox(
      database,
      queued.outboxId,
      "https://hooks.test/moqesh",
      now,
    )).resolves.toBe(false);
    const row = await database.prepare(
      "SELECT status, attempts FROM webhook_outbox WHERE id = ?",
    ).bind(queued.outboxId).first<{ status: string; attempts: number }>();
    expect(row).toEqual({ status: "dead", attempts: ALERT_MAX_ATTEMPTS });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("serializes concurrent first-confirmed enqueues across sources in local D1", async () => {
  const events = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    createEvent(now, index + 1)));
  const queued = await Promise.all(events.map((event) =>
    enqueueAlert(database, event, confirmation, now)));
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("accepted", { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);

  try {
    expect(queued.filter((item) => item.dispatchImmediately)).toHaveLength(1);
    expect(new Set(queued.map((item) => item.outboxId)).size).toBe(1);
    await Promise.all(queued.map((item) =>
      deliverOutbox(database, item.outboxId, "https://hooks.test/moqesh", now)));
    expect(fetchMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.alerts.map((item: { eventId: string }) => item.eventId).sort())
      .toEqual(events.map((event) => event.id).sort());
    const row = await database.prepare(
      "SELECT event_ids_json FROM webhook_outbox WHERE id = ?",
    ).bind(queued[0]!.outboxId).first<{ event_ids_json: string }>();
    expect(JSON.parse(row!.event_ids_json).sort()).toEqual(events.map((event) => event.id).sort());
  } finally {
    vi.unstubAllGlobals();
  }
});

it("retains every concurrent append exactly once in a pending local D1 group", async () => {
  const first = await createEvent();
  const initial = await enqueueAlert(database, first, confirmation, now);
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("accepted", { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);

  try {
    await deliverOutbox(database, initial.outboxId, "https://hooks.test/moqesh", now);
    const seed = await createEvent(now + minute);
    const pending = await enqueueAlert(database, seed, confirmation, now + minute);
    const events = await Promise.all(Array.from({ length: 12 }, () =>
      createEvent(now + 2 * minute)));
    const queued = await Promise.all(events.map((event) =>
      enqueueAlert(database, event, confirmation, now + 2 * minute)));
    expect(queued.every((item) => item.outboxId === pending.outboxId)).toBe(true);
    expect(queued.every((item) => !item.dispatchImmediately)).toBe(true);
    const expectedIds = [seed.id, ...events.map((event) => event.id)].sort();
    const row = await database.prepare(
      "SELECT event_ids_json FROM webhook_outbox WHERE id = ?",
    ).bind(pending.outboxId).first<{ event_ids_json: string }>();
    expect(JSON.parse(row!.event_ids_json).sort()).toEqual(expectedIds);

    await Promise.all(Array.from({ length: 6 }, () =>
      processPendingAlerts(database, "https://hooks.test/moqesh", now + 5 * minute)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(payload.alerts.map((item: { eventId: string }) => item.eventId).sort())
      .toEqual(expectedIds);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("atomically claims a local D1 group across concurrent delivery workers", async () => {
  const event = await createEvent();
  const queued = await enqueueAlert(database, event, confirmation, now);
  let release!: (response: Response) => void;
  const delivery = new Promise<Response>((resolve) => { release = resolve; });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => delivery);
  vi.stubGlobal("fetch", fetchMock);
  const attempts = Promise.all(Array.from({ length: 12 }, () =>
    deliverOutbox(database, queued.outboxId, "https://hooks.test/moqesh", now)));

  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const row = await database.prepare(
      "SELECT status, attempts FROM webhook_outbox WHERE id = ?",
    ).bind(queued.outboxId).first<{ status: string; attempts: number }>();
    expect(row).toEqual({ status: "sending", attempts: 1 });
  } finally {
    release(new Response("accepted", { status: 202 }));
    const results = await attempts;
    vi.unstubAllGlobals();
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.alerts.map((item: { eventId: string }) => item.eventId)).toEqual([event.id]);
  }
});

it("aborts a stalled webhook before stale recovery can start another active send", async () => {
  const event = await createEvent();
  const queued = await enqueueAlert(database, event, confirmation, now);
  let releaseFirst!: (response: Response) => void;
  let activeFetches = 0;
  let maxActiveFetches = 0;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    activeFetches += 1;
    maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
    if (fetchMock.mock.calls.length > 1) {
      activeFetches -= 1;
      return new Response("accepted", { status: 202 });
    }

    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          activeFetches -= 1;
          reject(new DOMException("Delivery timed out", "AbortError"));
        }, { once: true });
      } else {
        releaseFirst = (response) => {
          activeFetches -= 1;
          resolve(response);
        };
      }
    });
  });
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  const firstDelivery = deliverOutbox(
    database,
    queued.outboxId,
    "https://hooks.test/moqesh",
    now,
  );

  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const firstSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(firstSignal).toBeDefined();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(firstDelivery).resolves.toBe(false);
    expect(firstSignal?.aborted).toBe(true);

    await expect(processPendingAlerts(
      database,
      "https://hooks.test/moqesh",
      now + 60_000,
    )).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(maxActiveFetches).toBe(1);
  } finally {
    releaseFirst?.(new Response("accepted", { status: 202 }));
    await firstDelivery;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
