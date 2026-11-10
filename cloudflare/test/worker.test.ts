import { expect, it, vi } from "vitest";
import worker, { type Env } from "../src";
import { CHAIN_HOPS, hopToken } from "../src/rabbit-hole";

const sourceIp = "203.0.113.7";
const installationId = "opaque-test-installation";
const lureSecret = "unit-test-verifier-material";
const baitApiPath = "/api/private/account";

function createSnapshot(mode: "ordinary" | "maze" | "blocked") {
  return {
    mode,
    confirmedAt: mode === "ordinary" ? null : 1_000,
    mazeUntil: 901_000,
    blockUntil: mode === "ordinary" ? null : 87_301_000,
    mazeRequests: 0,
    throttledRequests: 0,
  };
}

function createSession(mode: "ordinary" | "maze" | "blocked" = "ordinary") {
  let current = createSnapshot(mode);
  let chainDepth = mode === "maze" ? 1 : 0;
  return {
    getMode: vi.fn(async () => ({ ...current, chainDepth })),
    confirmKeyReuse: vi.fn(async () => {
      current = createSnapshot("maze");
      chainDepth = 1;
      return { ...current, chainDepth };
    }),
    recordMazeRequest: vi.fn(async (budget: number) => ({
      state: { ...createSnapshot("maze"), mazeRequests: budget, chainDepth },
      throttled: false,
    })),
    advanceChain: vi.fn(async (hop: number) => {
      if (current.mode !== "maze" || hop > chainDepth + 1) {
        return { accepted: false, state: { ...current, chainDepth } };
      }
      chainDepth = Math.max(chainDepth, hop);
      if (hop === 10) current = createSnapshot("blocked");
      return { accepted: true, state: { ...current, chainDepth } };
    }),
    unblock: vi.fn(async () => createSnapshot("ordinary")),
  };
}

function createEnv(
  session = createSession(),
  options: {
    allowlisted?: string;
    eventsDb?: Env["EVENTS_DB"];
    alertConfirmation?: string;
    alertWebhookEnabled?: string;
    stateUnavailable?: boolean;
    responseBudget?: string;
  } = {},
) {
  const origin: Env["ORIGIN"] = {
    fetch: vi.fn(async () => new Response("origin-ok", { status: 200 })),
  };
  const sessionIdNames: string[] = [];
  const namespace = {
    idFromName: vi.fn((name: string) => {
      sessionIdNames.push(name);
      return name;
    }),
    get: vi.fn(() => {
      if (options.stateUnavailable) throw new Error("state unavailable");
      return session;
    }),
  };
  const env = {
    ORIGIN: origin,
    AGENT_SESSIONS: namespace,
    INSTALLATION_ID: installationId,
    LURE_KEY_SECRET: lureSecret,
    BAIT_API_PATH: baitApiPath,
    ALLOWLISTED_SOURCES: options.allowlisted,
    ALERT_CONFIRMATION: options.alertConfirmation,
    ALERT_WEBHOOK_ENABLED: options.alertWebhookEnabled,
    EVENTS_DB: options.eventsDb,
    MAZE_RESPONSE_BUDGET: options.responseBudget ?? "2",
  } as unknown as Env;
  return { env, origin, namespace, session, sessionIdNames };
}

function createEventsDatabase(dispatchImmediately = true) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const batches: { sql: string; params: unknown[] }[][] = [];
  const database = {
    prepare: vi.fn((sql: string) => {
      let params: unknown[] = [];
      return {
        bind: vi.fn((...values: unknown[]) => {
          params = values;
          return {
            sql,
            params,
            first: vi.fn(async () => sql.includes("SELECT lures_enabled")
              ? {
                  lures_enabled: 1,
                  maze_duration_minutes: 15,
                  block_duration_hours: 24,
                  response_budget: 2,
                  alert_grouping_minutes: 5,
                  retention_days: 30,
                }
              : null),
            all: vi.fn(async () => ({ results: [] })),
            run: vi.fn(async () => {
              statements.push({ sql, params });
              return { meta: { changes: 1 } };
            }),
          };
        }),
      };
    }),
    batch: vi.fn(async (batch: { sql?: string; params?: unknown[] }[]) => {
      batches.push(batch.map((statement) => ({
        sql: statement.sql ?? "",
        params: statement.params ?? [],
      })));
      return batch.map((_, index) => ({
        results: index === batch.length - 1
          ? [{ id: "pending-outbox", dispatch_immediately: dispatchImmediately ? 1 : 0 }]
          : [],
        meta: { changes: 0 },
      }));
    }),
  };
  return {
    database: database as unknown as Env["EVENTS_DB"],
    statements,
    batches,
  };
}

it("passes ordinary requests to the origin unchanged", async () => {
  const { env, origin } = createEnv();
  const request = new Request("https://site.test/home?view=full");
  const response = await worker.fetch(request, env);

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("origin-ok");
  expect(origin.fetch).toHaveBeenCalledOnce();
  expect(origin.fetch).toHaveBeenCalledWith(request);
});

it("passes ordinary requests to the proxied DNS origin when no ORIGIN binding exists", async () => {
  const { env } = createEnv();
  const dnsEnv = { ...env, ORIGIN: undefined, PUBLIC_SITE_HOSTNAME: "Site.Test" } as unknown as Env;
  const upstream = vi.fn(async () => new Response("dns-origin-ok", { status: 200 }));
  vi.stubGlobal("fetch", upstream);
  try {
    const request = new Request("https://site.test/home?view=full");
    const response = await worker.fetch(request, dnsEnv);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("dns-origin-ok");
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledWith(request);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  ["another hostname", "other.test"],
  ["no configured public hostname", undefined],
])("refuses DNS pass-through for %s", async (_label, publicHostname) => {
  const { env } = createEnv();
  const dnsEnv = { ...env, ORIGIN: undefined, PUBLIC_SITE_HOSTNAME: publicHostname } as unknown as Env;
  const upstream = vi.fn(async () => new Response("should-not-be-called"));
  vi.stubGlobal("fetch", upstream);
  try {
    const response = await worker.fetch(new Request("https://site.test/home"), dnsEnv);

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("handles the .env lure without sending it to the origin", async () => {
  const { env, origin } = createEnv();
  const response = await worker.fetch(new Request("https://site.test/.env"), env);

  expect(response.status).toBe(200);
  expect(await response.text()).toMatch(/^API_KEY=[a-f0-9]{64}$/m);
  expect(origin.fetch).not.toHaveBeenCalled();
});

it("records confirmed lure events without queuing webhooks when delivery is disabled", async () => {
  const session = createSession();
  const { database, statements, batches } = createEventsDatabase();
  const { env } = createEnv(session, {
    allowlisted: sourceIp,
    alertConfirmation: "true",
    alertWebhookEnabled: "false",
    eventsDb: database,
  });
  const lureResponse = await worker.fetch(
    new Request("https://site.test/.env", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    env,
  );
  const key = (await lureResponse.text()).match(/^API_KEY=(.+)$/m)?.[1];
  if (!key) throw new Error("The .env lure did not include its synthetic key");

  await worker.fetch(
    new Request(`https://site.test${baitApiPath}`, {
      headers: {
        Authorization: "Bearer " + key,
        "CF-Connecting-IP": sourceIp,
      },
    }),
    env,
  );

  const confirmedEvents = [...statements, ...batches.flat()].filter(({ sql, params }) =>
    sql.includes("INSERT INTO events") && params[2] === "confirmed_reuse");
  expect(session.confirmKeyReuse).not.toHaveBeenCalled();
  expect(confirmedEvents).toHaveLength(1);
  expect(batches).toEqual([]);
});

it("keeps webhook queuing enabled when the setting is omitted", async () => {
  const { database, batches } = createEventsDatabase(false);
  const { env } = createEnv(createSession(), {
    allowlisted: sourceIp,
    alertConfirmation: "true",
    eventsDb: database,
  });
  const lureResponse = await worker.fetch(
    new Request("https://site.test/.env", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    env,
  );
  const key = (await lureResponse.text()).match(/^API_KEY=(.+)$/m)?.[1];
  if (!key) throw new Error("The .env lure did not include its synthetic key");

  await worker.fetch(
    new Request(`https://site.test${baitApiPath}`, {
      headers: {
        Authorization: "Bearer " + key,
        "CF-Connecting-IP": sourceIp,
      },
    }),
    env,
  );

  expect(batches.flat().some(({ sql }) => sql.includes("INSERT INTO webhook_outbox"))).toBe(true);
});

it("keeps containment and event persistence active when alerts are disabled", async () => {
  const session = createSession();
  const { database, statements } = createEventsDatabase();
  const { env } = createEnv(session, {
    alertConfirmation: "true",
    alertWebhookEnabled: "false",
    eventsDb: database,
  });
  const lureResponse = await worker.fetch(
    new Request("https://site.test/.env", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    env,
  );
  const key = (await lureResponse.text()).match(/^API_KEY=(.+)$/m)?.[1];
  if (!key) throw new Error("The .env lure did not include its synthetic key");

  await worker.fetch(
    new Request(`https://site.test${baitApiPath}`, {
      headers: {
        Authorization: "Bearer " + key,
        "CF-Connecting-IP": sourceIp,
      },
    }),
    env,
  );

  const confirmedEvents = statements.filter(({ sql, params }) =>
    sql.includes("INSERT INTO events") && params[2] === "confirmed_reuse");
  expect(session.confirmKeyReuse).toHaveBeenCalledOnce();
  expect(confirmedEvents).toHaveLength(1);
  expect(statements.some(({ sql }) => sql.includes("INSERT INTO containment_sources"))).toBe(true);
});

it("keeps retention cleanup but skips webhook delivery during scheduled work when disabled", async () => {
  const { database, statements, batches } = createEventsDatabase();
  const { env } = createEnv(createSession(), {
    alertWebhookEnabled: "false",
    eventsDb: database,
  });
  const pending: Promise<unknown>[] = [];
  await worker.scheduled(
    { scheduledTime: Date.now(), cron: "* * * * *" },
    env,
    { waitUntil: (promise) => pending.push(promise) },
  );
  await Promise.all(pending);

  const cleanupSql = [
    ...statements.map(({ sql }) => sql),
    ...batches.flat().map(({ sql }) => sql),
  ];
  expect(cleanupSql.some((sql) => sql.includes("DELETE FROM events"))).toBe(true);
  expect(cleanupSql.some((sql) => sql.includes("DELETE FROM admin_audit"))).toBe(true);
  expect(cleanupSql.some((sql) => sql.includes("DELETE FROM containment_sources"))).toBe(true);
  expect(cleanupSql.some((sql) => sql.includes("DELETE FROM webhook_outbox"))).toBe(true);
  expect(cleanupSql.some((sql) => /UPDATE webhook_outbox\s+SET status/.test(sql))).toBe(false);
});

it("uses only CF-Connecting-IP and never trusts X-Forwarded-For", async () => {
  const { env, origin, namespace, sessionIdNames } = createEnv();
  const request = new Request("https://site.test/home", {
    headers: { "X-Forwarded-For": sourceIp },
  });

  const response = await worker.fetch(request, env);

  expect(await response.text()).toBe("origin-ok");
  expect(origin.fetch).toHaveBeenCalledWith(request);
  expect(namespace.idFromName).not.toHaveBeenCalled();
  expect(sessionIdNames).toEqual([]);
});

it("lets allowlisted ordinary requests bypass quarantine state", async () => {
  const session = createSession("blocked");
  const eventsDb = {
    prepare: vi.fn(() => {
      throw new Error("D1 unavailable");
    }),
  };
  const { env, origin, namespace } = createEnv(session, {
    allowlisted: sourceIp,
    eventsDb: eventsDb as unknown as Env["EVENTS_DB"],
  });
  const request = new Request("https://site.test/home", {
    headers: { "CF-Connecting-IP": sourceIp },
  });

  const response = await worker.fetch(request, env);

  expect(await response.text()).toBe("origin-ok");
  expect(origin.fetch).toHaveBeenCalledWith(request);
  expect(namespace.get).not.toHaveBeenCalled();
  expect(eventsDb.prepare).not.toHaveBeenCalled();
});

it("keeps configured lures decoy-only for allowlisted sources", async () => {
  const session = createSession("blocked");
  const { env, origin, namespace } = createEnv(session, { allowlisted: sourceIp });
  const response = await worker.fetch(
    new Request("https://site.test/.env", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    env,
  );

  expect(response.status).toBe(200);
  expect(await response.text()).toMatch(/^API_KEY=[a-f0-9]{64}$/m);
  expect(origin.fetch).not.toHaveBeenCalled();
  expect(namespace.get).not.toHaveBeenCalled();
});

it("keeps ordinary unconfirmed sources on the origin", async () => {
  const { env, origin, namespace, session } = createEnv();
  const request = new Request("https://site.test/home", {
    headers: { "CF-Connecting-IP": sourceIp },
  });

  const response = await worker.fetch(request, env);

  expect(await response.text()).toBe("origin-ok");
  expect(origin.fetch).toHaveBeenCalledWith(request);
  expect(namespace.get).toHaveBeenCalledOnce();
  expect(session.confirmKeyReuse).not.toHaveBeenCalled();
});

it("starts quarantine after a valid synthetic-key reuse without exposing the key", async () => {
  const { env, origin, session } = createEnv();
  const lureResponse = await worker.fetch(
    new Request("https://site.test/.env", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    env,
  );
  const key = (await lureResponse.text()).match(/^API_KEY=(.+)$/m)?.[1];
  if (!key) throw new Error("The .env lure did not include its synthetic key");

  const response = await worker.fetch(
    new Request(`https://site.test${baitApiPath}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "CF-Connecting-IP": sourceIp,
      },
    }),
    env,
  );

  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain(key);
  expect(session.confirmKeyReuse).toHaveBeenCalledOnce();
  expect(origin.fetch).not.toHaveBeenCalled();
});

it("serves decoys for every route during maze and never reaches the origin", async () => {
  const session = createSession("maze");
  session.recordMazeRequest.mockImplementation(async (budget: number) => ({
    state: { ...createSnapshot("maze"), mazeRequests: budget, chainDepth: 1 },
    throttled: false,
  }));
  const { env, origin, sessionIdNames } = createEnv(session);

  const ordinary = await worker.fetch(
    new Request("https://site.test/private/data", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    env,
  );
  const lure = await worker.fetch(
    new Request("https://site.test/.env", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    env,
  );

  expect(ordinary.status).toBe(404);
  expect(lure.status).toBe(404);
  expect(await ordinary.text()).toBe(await lure.text());
  expect(origin.fetch).not.toHaveBeenCalled();
  expect(session.recordMazeRequest).toHaveBeenCalledTimes(2);
  expect(sessionIdNames.every((name) => !name.includes(sourceIp))).toBe(true);
});

it("denies blocked sources without reaching the origin", async () => {
  const { env, origin, session } = createEnv(createSession("blocked"));
  const response = await worker.fetch(
    new Request("https://site.test/private/data", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    env,
  );

  expect(response.status).toBe(403);
  expect(origin.fetch).not.toHaveBeenCalled();
  expect(session.recordMazeRequest).not.toHaveBeenCalled();
});

it("does not bypass blocked state when the dynamic allowlist lookup fails", async () => {
  const eventsDb = {
    prepare: vi.fn(() => {
      throw new Error("D1 unavailable");
    }),
  };
  const { env, origin } = createEnv(createSession("blocked"), {
    eventsDb: eventsDb as unknown as Env["EVENTS_DB"],
  });
  const response = await worker.fetch(
    new Request("https://site.test/private/data", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    env,
  );

  expect(response.status).toBe(403);
  expect(origin.fetch).not.toHaveBeenCalled();
});

it("throttles at the configured response budget with the bounded decoy", async () => {
  const session = createSession("maze");
  session.recordMazeRequest.mockImplementation(async (budget: number) => ({
    state: {
      ...createSnapshot("maze"),
      mazeRequests: budget,
      throttledRequests: 1,
      chainDepth: 1,
    },
    throttled: true,
  }));
  const { env, origin } = createEnv(session, { responseBudget: "3" });
  const response = await worker.fetch(
    new Request("https://site.test/private/data", {
      headers: { "CF-Connecting-IP": sourceIp },
    }),
    env,
  );

  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBeTruthy();
  expect(await response.text()).toContain("Not found");
  expect(session.recordMazeRequest).toHaveBeenCalledWith(3);
  expect(origin.fetch).not.toHaveBeenCalled();
});

it("caches a bounded generic decoy without skipping maze accounting", async () => {
  const session = createSession("maze");
  session.recordMazeRequest.mockImplementation(async (budget: number) => ({
    state: {
      ...createSnapshot("maze"),
      mazeRequests: budget,
      throttledRequests: 1,
      chainDepth: 1,
    },
    throttled: true,
  }));
  const { env } = createEnv(session, { responseBudget: "3" });
  const entries = new Map<string, Response>();
  const cacheMatch = vi.fn(async (key: Request | string) =>
    entries.get(typeof key === "string" ? key : key.url)?.clone(),
  );
  const cachePut = vi.fn(async (key: Request | string, response: Response) => {
    entries.set(typeof key === "string" ? key : key.url, response.clone());
  });
  vi.stubGlobal("caches", { default: { match: cacheMatch, put: cachePut } });

  try {
    const first = await worker.fetch(
      new Request("https://site.test/private/data?secret=query-value", {
        headers: { "CF-Connecting-IP": sourceIp },
      }),
      env,
    );
    const second = await worker.fetch(
      new Request("https://site.test/another-path?key=sensitive-key", {
        headers: { "CF-Connecting-IP": sourceIp },
      }),
      env,
    );

    expect(first.status).toBe(429);
    expect(second.status).toBe(429);
    expect(first.headers.get("Retry-After")).toBeTruthy();
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(await first.text()).toBe('{"error":"Not found"}');
    expect(await second.text()).toBe('{"error":"Not found"}');
    expect(session.recordMazeRequest).toHaveBeenCalledTimes(2);
    expect(cacheMatch).toHaveBeenCalledTimes(2);
    expect(cachePut).toHaveBeenCalledOnce();

    const cacheKey = cachePut.mock.calls[0]?.[0];
    expect(cacheKey).toBeInstanceOf(Request);
    expect((cacheKey as Request).url).not.toContain(sourceIp);
    expect((cacheKey as Request).url).not.toContain("secret");
    expect((cacheKey as Request).url).not.toContain("sensitive-key");
    const cachedDecoy = cachePut.mock.calls[0]?.[1];
    expect(cachedDecoy?.headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(await cachedDecoy?.text()).toBe('{"error":"Not found"}');
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reports cache failure while keeping throttling enforced", async () => {
  const session = createSession("maze");
  session.recordMazeRequest.mockImplementation(async (budget: number) => ({
    state: {
      ...createSnapshot("maze"),
      mazeRequests: budget,
      throttledRequests: 1,
      chainDepth: 1,
    },
    throttled: true,
  }));
  const { env } = createEnv(session, { responseBudget: "3" });
  const cacheMatch = vi.fn(async () => {
    throw new Error("cache unavailable");
  });
  const cachePut = vi.fn();
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("caches", { default: { match: cacheMatch, put: cachePut } });

  try {
    const response = await worker.fetch(
      new Request("https://site.test/private/data", {
        headers: { "CF-Connecting-IP": sourceIp },
      }),
      env,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(session.recordMazeRequest).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "Maze decoy cache unavailable; using uncached throttled response",
    );
    expect(cachePut).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    error.mockRestore();
  }
});

it("fails open for ordinary traffic but keeps lures decoy-only when state is unavailable", async () => {
  const { env, origin } = createEnv(createSession(), { stateUnavailable: true });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const ordinary = await worker.fetch(
      new Request("https://site.test/home", {
        headers: { "CF-Connecting-IP": sourceIp },
      }),
      env,
    );
    const lure = await worker.fetch(
      new Request("https://site.test/.env", {
        headers: { "CF-Connecting-IP": sourceIp },
      }),
      env,
    );

    expect(await ordinary.text()).toBe("origin-ok");
    expect(lure.status).toBe(200);
    expect(await lure.text()).toMatch(/^API_KEY=[a-f0-9]{64}$/m);
    expect(origin.fetch).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

it("records every disclosure lure as an unconfirmed view without reaching the origin", async () => {
  const { database, statements } = createEventsDatabase();
  const { env, origin, session } = createEnv(createSession(), { eventsDb: database });
  const lures = {
    "/.env.production": "env-production",
    "/.git/config": "git-config",
    "/.aws/credentials": "aws-credentials",
    "/config.json": "config-json",
    "/wp-config.php.bak": "wp-config-backup",
    "/backup.sql": "sql-backup",
    "/api/v1/keys": "api-keys",
    "/swagger.json": "swagger",
  };
  for (const path of Object.keys(lures)) {
    const response = await worker.fetch(
      new Request(`https://site.test${path}`, { headers: { "CF-Connecting-IP": sourceIp } }),
      env,
    );
    expect(response.status).toBe(200);
  }

  const events = statements.filter(({ sql }) => sql.includes("INSERT INTO events"));
  expect(events.map(({ params }) => [params[2], params[3]])).toEqual(
    Object.values(lures).map((route) => ["unconfirmed_lure_view", route]),
  );
  expect(origin.fetch).not.toHaveBeenCalled();
  expect(session.confirmKeyReuse).not.toHaveBeenCalled();
});

it("contains a source that reuses a key discovered in config.json", async () => {
  const { env, session } = createEnv();
  const config = await (await worker.fetch(
    new Request("https://site.test/config.json", { headers: { "CF-Connecting-IP": sourceIp } }),
    env,
  )).json() as { api: { apiKey: string } };

  const response = await worker.fetch(
    new Request(`https://site.test${baitApiPath}`, {
      headers: { Authorization: `Bearer ${config.api.apiKey}`, "CF-Connecting-IP": sourceIp },
    }),
    env,
  );

  expect(response.status).toBe(200);
  expect(session.confirmKeyReuse).toHaveBeenCalledOnce();
});

it("serves robots.txt lure hints without an event or origin request", async () => {
  const { database, statements } = createEventsDatabase();
  const { env, origin } = createEnv(createSession(), { eventsDb: database });
  const response = await worker.fetch(
    new Request("https://site.test/robots.txt", { headers: { "CF-Connecting-IP": sourceIp } }),
    env,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/plain");
  expect(await response.text()).toContain("Disallow: /.git/config\n");
  expect(origin.fetch).not.toHaveBeenCalled();
  expect(statements.filter(({ sql }) => sql.includes("INSERT INTO events"))).toEqual([]);
});

function hopRequest(path: string, token: string) {
  return new Request(`https://site.test${path}`, {
    headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": sourceIp },
  });
}

function rootRequest() {
  return new Request("https://site.test/", { headers: { "CF-Connecting-IP": sourceIp } });
}

it("walks all ten hops, logs each, keeps the origin unreachable, then blocks", async () => {
  const events = createEventsDatabase();
  const { env, origin, session } = createEnv(createSession(), { eventsDb: events.database });
  const lure = await worker.fetch(
    new Request("https://site.test/.env", { headers: { "CF-Connecting-IP": sourceIp } }),
    env,
  );
  const key = (await lure.text()).match(/^API_KEY=(.+)$/m)![1];

  let body = await (await worker.fetch(hopRequest(baitApiPath, key), env)).json() as {
    next?: { endpoint: string; authorization: string };
  };
  for (const hop of CHAIN_HOPS) {
    expect(body.next!.endpoint).toBe(`https://site.test${hop.path}`);
    expect((await worker.fetch(rootRequest(), env)).status).toBe(404);
    const response = await worker.fetch(hopRequest(hop.path, body.next!.authorization.slice(7)), env);
    expect(response.status).toBe(200);
    body = await response.json() as typeof body;
  }
  expect(body.next).toBeUndefined();
  expect((await worker.fetch(rootRequest(), env)).status).toBe(403);
  expect(origin.fetch).not.toHaveBeenCalled();
  expect(session.advanceChain).toHaveBeenCalledTimes(9);
  const hopRoutes = events.statements
    .filter(({ sql, params }) => sql.includes("INSERT INTO events") && params[2] === "rabbit_hole_hop")
    .map(({ params }) => params[3]);
  expect(hopRoutes).toEqual(CHAIN_HOPS.map((hop) => hop.route));
});

it("returns the maze 404 for a wrong token or a skipped hop", async () => {
  const { env, session } = createEnv(createSession("maze"));
  const hop3 = CHAIN_HOPS[1];
  const wrong = await worker.fetch(hopRequest(hop3.path, await hopToken(lureSecret, 4)), env);
  const skipped = await worker.fetch(hopRequest(hop3.path, await hopToken(lureSecret, 3)), env);
  expect(wrong.status).toBe(404);
  expect(skipped.status).toBe(404);
  expect(await skipped.text()).toBe('{"error":"Not found"}');
  expect(session.recordMazeRequest).toHaveBeenCalledTimes(2);
});

it("does not serve chain hops to ordinary sources", async () => {
  const { env, origin, session } = createEnv();
  const response = await worker.fetch(hopRequest(CHAIN_HOPS[0].path, await hopToken(lureSecret, 2)), env);
  expect(await response.text()).toBe("origin-ok");
  expect(origin.fetch).toHaveBeenCalledOnce();
  expect(session.advanceChain).not.toHaveBeenCalled();
});

it("re-serves hop 1 to a contained source that reuses the key again", async () => {
  const { env, origin, session } = createEnv(createSession("maze"));
  const lure = await worker.fetch(new Request("https://site.test/.env"), env);
  const key = (await lure.text()).match(/^API_KEY=(.+)$/m)![1];
  const response = await worker.fetch(hopRequest(baitApiPath, key), env);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { next: { endpoint: string } }).next.endpoint)
    .toBe(`https://site.test${CHAIN_HOPS[0].path}`);
  expect(origin.fetch).not.toHaveBeenCalled();
  expect(session.confirmKeyReuse).toHaveBeenCalledOnce();
});
