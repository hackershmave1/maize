import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test as nodeTest } from "node:test";

const migrationModule = await import("../scripts/apply-d1-migrations.mjs").catch(
  () => ({}),
);
const secretModule = await import("../scripts/provision-worker-secrets.mjs").catch(
  () => ({}),
);

function apiResponse(result = []) {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

nodeTest("D1 migration runner refuses Wrangler's local placeholder database ID", async () => {
  assert.equal(typeof migrationModule.applyD1Migrations, "function");
  let requests = 0;

  await assert.rejects(
    migrationModule.applyD1Migrations({
      accountId: "a".repeat(32),
      databaseId: "00000000-0000-0000-0000-000000000001",
      migrationsDirectory: new URL("../../migrations/", import.meta.url),
      installationId: "installation-test",
      settings: {
        mazeDurationMinutes: 15,
        blockDurationHours: 24,
        responseBudget: 100,
        alertGroupingMinutes: 5,
        retentionDays: 30,
      },
      token: "not-a-real-token",
      fetcher: async () => {
        requests += 1;
        return apiResponse();
      },
    }),
    /Wrangler local placeholder/,
  );
  assert.equal(requests, 0);
});

nodeTest("D1 migration runner applies and verifies all schema migrations against the supplied database ID", async () => {
  assert.equal(typeof migrationModule.applyD1Migrations, "function");
  const migrationNames = [];
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url: String(url), init });
    const body = JSON.parse(init.body);
    if (body.sql?.includes("CREATE TABLE IF NOT EXISTS __moqesh_schema_migrations")) {
      return apiResponse([{ results: [] }]);
    }
    if (body.sql?.includes("SELECT name FROM __moqesh_schema_migrations")) {
      return apiResponse([{
        results: migrationNames.map((name) => ({ name })),
      }]);
    }
    if (body.sql?.includes("SELECT installation_id FROM runtime_settings")) {
      return apiResponse([{ results: [{ installation_id: "installation-test" }] }]);
    }
    if (body.sql?.includes("INSERT INTO runtime_settings")) {
      assert.deepEqual(body.params, [
        "installation-test",
        "15",
        "24",
        "100",
        "5",
        "30",
      ]);
      return apiResponse([{ results: [] }]);
    }
    if (body.batch) {
      const migrationQuery = body.batch[0];
      const recordQuery = body.batch[1];
      assert.match(migrationQuery.sql, /CREATE TABLE|ALTER TABLE/);
      assert.match(recordQuery.sql, /INSERT INTO __moqesh_schema_migrations/);
      migrationNames.push(recordQuery.params[0]);
      return apiResponse([{ results: [] }, { results: [] }]);
    }
    throw new Error(`Unexpected SQL request: ${body.sql}`);
  };

  await migrationModule.applyD1Migrations({
    accountId: "a".repeat(32),
    databaseId: "12345678-1234-1234-1234-123456789abc",
    migrationsDirectory: new URL("../../migrations/", import.meta.url),
    installationId: "installation-test",
    settings: {
      mazeDurationMinutes: 15,
      blockDurationHours: 24,
      responseBudget: 100,
      alertGroupingMinutes: 5,
      retentionDays: 30,
    },
    token: "not-a-real-token",
    fetcher,
  });

  assert.deepEqual(migrationNames, [
    "0001_events.sql",
    "0002_admin.sql",
    "0003_containment_sources.sql",
  ]);
  assert.ok(requests.every(({ url }) =>
    url.endsWith("/d1/database/12345678-1234-1234-1234-123456789abc/query")));
  const migrationFiles = await Promise.all(migrationNames.map((name) =>
    readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8")));
  for (const migration of migrationFiles) {
    assert.ok(requests.some(({ init }) => {
      const body = JSON.parse(init.body);
      return (body.batch ?? [body]).some((query) => query.sql === migration);
    }));
  }
});

nodeTest("secret provisioner uploads Worker secrets without printing their values", async () => {
  assert.equal(typeof secretModule.provisionWorkerSecrets, "function");
  const calls = [];
  const logged = [];
  const originalLog = console.log;
  const lureSecret = "local-test-secret-0123456789-abcdefgh";
  const webhookUrl = "https://hooks.example.invalid/replace-me";

  console.log = (...values) => logged.push(values.join(" "));
  try {
    await secretModule.provisionWorkerSecrets({
      accountId: "a".repeat(32),
      scriptName: "moqesh-cloudflare",
      token: "not-a-real-token",
      lureKeySecret: lureSecret,
      alertWebhookUrl: webhookUrl,
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        return init.method === "PATCH"
          ? apiResponse({})
          : apiResponse([
            { name: "LURE_KEY_SECRET", type: "secret_text" },
            { name: "ALERT_WEBHOOK_URL", type: "secret_text" },
          ]);
      },
    });
  } finally {
    console.log = originalLog;
  }

  assert.match(calls[0].url, /\/workers\/scripts\/moqesh-cloudflare\/secrets-bulk$/);
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal(calls[0].init.headers.Authorization, "Bearer not-a-real-token");
  const payload = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(payload.secrets).sort(), [
    "ALERT_WEBHOOK_URL",
    "LURE_KEY_SECRET",
  ]);
  assert.deepEqual(payload.secrets.LURE_KEY_SECRET, {
    name: "LURE_KEY_SECRET",
    type: "secret_text",
    text: lureSecret,
  });
  assert.deepEqual(payload.secrets.ALERT_WEBHOOK_URL, {
    name: "ALERT_WEBHOOK_URL",
    type: "secret_text",
    text: webhookUrl,
  });
  assert.match(calls[1].url, /\/workers\/scripts\/moqesh-cloudflare\/secrets$/);
  assert.equal(calls[1].init.method, "GET");
  assert.equal(logged.join("\n").includes(lureSecret), false);
  assert.equal(logged.join("\n").includes(webhookUrl), false);
});

nodeTest("secret provisioner uploads and verifies only the lure key when webhook alerts are disabled", async () => {
  assert.equal(typeof secretModule.provisionWorkerSecrets, "function");
  const calls = [];

  await secretModule.provisionWorkerSecrets({
    accountId: "a".repeat(32),
    scriptName: "moqesh-kurocyber-staging",
    token: "not-a-real-token",
    lureKeySecret: "local-test-secret-0123456789-abcdefgh",
    alertWebhookEnabled: false,
    fetcher: async (url, init) => {
      calls.push({ url: String(url), init });
      return init.method === "PATCH"
        ? apiResponse({})
        : apiResponse([{ name: "LURE_KEY_SECRET", type: "secret_text" }]);
    },
  });

  const payload = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(payload.secrets), ["LURE_KEY_SECRET"]);
  assert.deepEqual(payload.secrets.LURE_KEY_SECRET, {
    name: "LURE_KEY_SECRET",
    type: "secret_text",
    text: "local-test-secret-0123456789-abcdefgh",
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/workers\/scripts\/moqesh-kurocyber-staging\/secrets$/);
});

nodeTest("disabled secret provisioner still rejects a weak lure key before making API calls", async () => {
  assert.equal(typeof secretModule.provisionWorkerSecrets, "function");
  let requests = 0;

  await assert.rejects(
    secretModule.provisionWorkerSecrets({
      accountId: "a".repeat(32),
      scriptName: "moqesh-kurocyber-staging",
      token: "not-a-real-token",
      lureKeySecret: "too-short",
      alertWebhookEnabled: false,
      fetcher: async () => {
        requests += 1;
        return apiResponse();
      },
    }),
    /at least 32 bytes/,
  );
  assert.equal(requests, 0);
});

nodeTest("secret provisioner rejects weak lure keys before making API calls", async () => {
  assert.equal(typeof secretModule.provisionWorkerSecrets, "function");
  let requests = 0;

  await assert.rejects(
    secretModule.provisionWorkerSecrets({
      accountId: "a".repeat(32),
      scriptName: "moqesh-cloudflare",
      token: "not-a-real-token",
      lureKeySecret: "too-short",
      alertWebhookUrl: "https://hooks.example.invalid/replace-me",
      fetcher: async () => {
        requests += 1;
        return apiResponse();
      },
    }),
    /at least 32 bytes/,
  );
  assert.equal(requests, 0);
});
