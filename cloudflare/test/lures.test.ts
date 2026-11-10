import { expect, it, vi } from "vitest";
import { handleLure, isLureRequest, robotsTxt } from "../src/lures";
import type { Env } from "../src";

const verifierMaterial = "unit-test-verifier-material";
const baitApiPath = "/api/private/account";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ORIGIN: {
      fetch: async () => new Response("origin-ok"),
    },
    LURE_KEY_SECRET: verifierMaterial,
    BAIT_API_PATH: baitApiPath,
    ...overrides,
  };
}

it("serves a synthetic .env lure without confirming or alerting", async () => {
  const result = await handleLure(
    new Request("https://lure.test/.env"),
    createEnv(),
  );
  const fixture = await result.response.text();

  expect(result.response.status).toBe(200);
  expect(fixture).toMatch(/^API_KEY=[a-f0-9]{64}$/m);
  expect(fixture).toContain(`API_BASE_URL=https://lure.test${baitApiPath}`);
  expect(result.event).toMatchObject({
    type: "lure",
    route: "env-file",
    source: null,
    confirmed: false,
  });
  expect(result).not.toHaveProperty("alert");
});

it("derives different synthetic keys from different installation verifier material", async () => {
  const first = await handleLure(
    new Request("https://lure.test/.env"),
    createEnv(),
  );
  const second = await handleLure(
    new Request("https://lure.test/.env"),
    createEnv({ LURE_KEY_SECRET: "different-installation-verifier" }),
  );
  const firstFixture = await first.response.text();
  const secondFixture = await second.response.text();
  const firstKey = firstFixture.match(/^API_KEY=(.+)$/m)?.[1];
  const secondKey = secondFixture.match(/^API_KEY=(.+)$/m)?.[1];

  expect(firstKey).toMatch(/^[a-f0-9]{64}$/);
  expect(secondKey).toMatch(/^[a-f0-9]{64}$/);
  expect(firstKey).not.toBe(secondKey);
  expect(firstFixture).not.toContain(verifierMaterial);
});

it("allows a configured direct-lure alert for an allowlisted source", async () => {
  const request = new Request("https://lure.test/.env", {
    headers: { "CF-Connecting-IP": "203.0.113.7" },
  });
  const result = await handleLure(
    request,
    createEnv({
      ALLOWLISTED_SOURCES: "203.0.113.7",
      ALERT_DIRECT_LURE: "true",
    }),
  );

  expect(result.event.confirmed).toBe(false);
  expect(result.alert).toMatchObject({
    type: "direct-lure",
    source: "203.0.113.7",
    route: "env-file",
  });
  expect(result).not.toHaveProperty("maze");
  expect(result).not.toHaveProperty("block");
});

it("returns an unauthorized decoy for an invalid API key without confirmation or timer", async () => {
  vi.useFakeTimers();
  try {
    const result = await handleLure(
      new Request(`https://lure.test${baitApiPath}?key=not-a-valid-key`),
      createEnv(),
    );

    expect(result.response.status).toBe(401);
    expect(await result.response.text()).not.toContain("not-a-valid-key");
    expect(result.event).toMatchObject({
      type: "lure",
      route: "bait-api",
      confirmed: false,
    });
    expect(result).not.toHaveProperty("alert");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("confirms a valid key from Authorization without returning or recording the key", async () => {
  const env = createEnv();
  const lure = await handleLure(
    new Request("https://lure.test/.env"),
    env,
  );
  const fixture = await lure.response.text();
  const key = fixture.match(/^API_KEY=(.+)$/m)?.[1];
  if (!key) throw new Error("The .env lure did not include its synthetic key");

  const result = await handleLure(
    new Request(`https://lure.test${baitApiPath}`, {
      headers: { Authorization: `Bearer ${key}` },
    }),
    env,
  );
  const body = await result.response.text();

  expect(result.response.status).toBe(200);
  expect(body).toContain('"readonly":true');
  expect(body).not.toContain(key);
  expect(result.event.confirmed).toBe(true);
  expect(JSON.stringify(result.event)).not.toContain(key);
  expect(JSON.stringify(result.alert ?? {})).not.toContain(key);
});

it("may alert on allowlisted confirmation without starting a maze or blocking", async () => {
  const env = createEnv({
    ALLOWLISTED_SOURCES: "203.0.113.9",
    ALERT_CONFIRMATION: "true",
  });
  const lure = await handleLure(new Request("https://lure.test/.env"), env);
  const key = (await lure.response.text()).match(/^API_KEY=(.+)$/m)?.[1];
  if (!key) throw new Error("The .env lure did not include its synthetic key");

  const result = await handleLure(
    new Request(`https://lure.test${baitApiPath}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "CF-Connecting-IP": "203.0.113.9",
      },
    }),
    env,
  );

  expect(result.event.confirmed).toBe(true);
  expect(result.alert).toMatchObject({
    type: "confirmation",
    source: "203.0.113.9",
    route: "bait-api",
  });
  expect(result).not.toHaveProperty("maze");
  expect(result).not.toHaveProperty("block");
});

const disclosureLures = [
  ["/.env.production", "env-production", "text/plain"],
  ["/.git/config", "git-config", "text/plain"],
  ["/.aws/credentials", "aws-credentials", "text/plain"],
  ["/config.json", "config-json", "application/json"],
  ["/wp-config.php.bak", "wp-config-backup", "text/plain"],
  ["/backup.sql", "sql-backup", "application/sql"],
  ["/api/v1/keys", "api-keys", "application/json"],
] as const;

it.each(disclosureLures)(
  "serves %s as an unconfirmed disclosure lure leaking the same synthetic key",
  async (path, route, contentType) => {
    const env = createEnv();
    const dotEnv = await (await handleLure(new Request("https://lure.test/.env"), env)).response.text();
    const key = dotEnv.match(/^API_KEY=(.+)$/m)?.[1];
    expect(isLureRequest(new Request(`https://lure.test${path}`), env)).toBe(true);

    const result = await handleLure(new Request(`https://lure.test${path}`), env);
    const body = await result.response.text();

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("Content-Type")).toContain(contentType);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(body).toContain(key);
    expect(body).toContain(`https://lure.test${baitApiPath}`);
    expect(body).not.toContain(verifierMaterial);
    expect(result.event).toMatchObject({ route, confirmed: false });
    expect(result).not.toHaveProperty("alert");
  },
);

it("serves an OpenAPI swagger lure that advertises the bait API without leaking the key", async () => {
  const env = createEnv();
  const result = await handleLure(new Request("https://lure.test/swagger.json"), env);
  const spec = await result.response.json() as { paths: Record<string, unknown>; components: unknown };

  expect(result.response.status).toBe(200);
  expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([baitApiPath, "/api/v1/keys"]));
  expect(JSON.stringify(spec.components)).toContain("bearer");
  expect(JSON.stringify(spec)).not.toMatch(/[a-f0-9]{64}/);
  expect(result.event).toMatchObject({ route: "swagger", confirmed: false });
});

it("does not treat robots.txt or near-miss paths as lures", () => {
  const env = createEnv();
  for (const path of ["/robots.txt", "/.env.bak", "/.git/config/", "/config.json.old", "/api/v1/keys/1"]) {
    expect(isLureRequest(new Request(`https://lure.test${path}`), env)).toBe(false);
  }
});

it("lists every lure in a robots.txt disallow hint", () => {
  const body = robotsTxt(createEnv());
  for (const path of ["/.env", "/.git/config", "/backup.sql", "/api/v1/keys", "/swagger.json", baitApiPath]) {
    expect(body).toContain(`Disallow: ${path}\n`);
  }
  expect(body.startsWith("User-agent: *\n")).toBe(true);
});
