import { env as cloudflareEnv } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import schema from "../migrations/0001_events.sql?raw";
import {
  deleteExpiredEvents,
  getEvent,
  listEvents,
  recordEvent,
  type EventDatabase,
  type EventInput,
} from "../src/events";

const database = (cloudflareEnv as { EVENTS_DB: EventDatabase }).EVENTS_DB;
const retentionMs = 30 * 24 * 60 * 60 * 1_000;

beforeAll(async () => {
  for (const statement of schema.split(";").map((part) => part.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
});

async function clearEvents(): Promise<void> {
  await database.prepare("DELETE FROM webhook_outbox WHERE installation_id = ?")
    .bind("installation-a").run();
  await database.prepare("DELETE FROM runtime_settings WHERE installation_id = ?")
    .bind("installation-a").run();
  await database.prepare("DELETE FROM events WHERE installation_id = ?")
    .bind("installation-a").run();
}

it("records unconfirmed lure views without creating an alert", async () => {
  await clearEvents();
  const event = await recordEvent(database, {
    installationId: "installation-a",
    type: "unconfirmed_lure_view",
    route: "env-file",
    sourceIp: "203.0.113.7",
    confirmed: false,
  });

  expect(event).toMatchObject({
    installationId: "installation-a",
    type: "unconfirmed_lure_view",
    route: "env-file",
    sourceIp: "203.0.113.7",
    confirmed: false,
  });
  expect(await listEvents(database, "installation-a")).toEqual([event]);
  expect(await database.prepare("SELECT id FROM webhook_outbox").all()).toMatchObject({
    results: [],
  });
});

it("records invalid-key attempts without marking them confirmed", async () => {
  await clearEvents();
  const event = await recordEvent(database, {
    installationId: "installation-a",
    type: "invalid_key_attempt",
    route: "bait-api",
    sourceIp: "2001:db8::7",
    confirmed: false,
  });

  expect(await getEvent(database, event.id)).toEqual(event);
  expect(event.sourceIp).toBe("2001:db8::7");
});

it("records confirmed reuse with the full source IP", async () => {
  await clearEvents();
  const event = await recordEvent(database, {
    installationId: "installation-a",
    type: "confirmed_reuse",
    route: "bait-api",
    sourceIp: "198.51.100.203",
    confirmed: true,
  });

  expect(event.sourceIp).toBe("198.51.100.203");
  expect(event.confirmed).toBe(true);
});

it("records a block event without storing a request path", async () => {
  await clearEvents();
  const event = await recordEvent(database, {
    installationId: "installation-a",
    type: "block",
    route: null,
    sourceIp: "198.51.100.203",
    confirmed: true,
  });

  expect(event.type).toBe("block");
  expect(event.route).toBeNull();
});

it("stores only the allowlisted event fields, never request secrets", async () => {
  await clearEvents();
  const secrets = [
    "synthetic-key-sentinel",
    "authorization-sentinel",
    "cookie-sentinel",
    "request-body-sentinel",
    "query-sentinel",
  ];
  const event = await recordEvent(database, {
    installationId: "installation-a",
    type: "confirmed_reuse",
    route: "bait-api",
    sourceIp: "203.0.113.7",
    confirmed: true,
    syntheticKey: secrets[0],
    authorization: secrets[1],
    cookies: secrets[2],
    requestBody: secrets[3],
    queryString: secrets[4],
  } as EventInput);
  const rows = await database.prepare("SELECT * FROM events").all();
  const stored = JSON.stringify(rows.results);

  expect(stored).not.toContain("syntheticKey");
  for (const secret of secrets) expect(stored).not.toContain(secret);
  expect(await getEvent(database, event.id)).toEqual(event);
});

it("deletes only events at or beyond the 30-day retention cutoff", async () => {
  await clearEvents();
  const now = 2_000_000_000_000;
  const beforeCutoff = await recordEvent(database, {
    installationId: "installation-a",
    type: "invalid_key_attempt",
    route: "bait-api",
    sourceIp: "203.0.113.7",
    confirmed: false,
  }, now - retentionMs - 1);
  const atCutoff = await recordEvent(database, {
    installationId: "installation-a",
    type: "block",
    route: null,
    sourceIp: "203.0.113.8",
    confirmed: true,
  }, now - retentionMs);
  const recent = await recordEvent(database, {
    installationId: "installation-a",
    type: "confirmed_reuse",
    route: "bait-api",
    sourceIp: "203.0.113.9",
    confirmed: true,
  }, now - retentionMs + 1);

  expect(await deleteExpiredEvents(database, now)).toBe(2);
  expect(await listEvents(database, "installation-a")).toEqual([recent]);
  expect(await getEvent(database, beforeCutoff.id)).toBeNull();
  expect(await getEvent(database, atCutoff.id)).toBeNull();
});
