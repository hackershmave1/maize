import { expect, it, vi } from "vitest";
import worker, { type Env } from "../src";

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
  return {
    getMode: vi.fn(async () => createSnapshot(mode)),
    confirmKeyReuse: vi.fn(async () => createSnapshot("maze")),
    recordMazeRequest: vi.fn(async (budget: number) => ({
      state: { ...createSnapshot("maze"), mazeRequests: budget },
      throttled: false,
    })),
    unblock: vi.fn(async () => createSnapshot("ordinary")),
  };
}

function createEnv(
  session = createSession(),
  options: {
    allowlisted?: string;
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
    MAZE_RESPONSE_BUDGET: options.responseBudget ?? "2",
  } as unknown as Env;
  return { env, origin, namespace, session, sessionIdNames };
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

it("handles the .env lure without sending it to the origin", async () => {
  const { env, origin } = createEnv();
  const response = await worker.fetch(new Request("https://site.test/.env"), env);

  expect(response.status).toBe(200);
  expect(await response.text()).toMatch(/^API_KEY=[a-f0-9]{64}$/m);
  expect(origin.fetch).not.toHaveBeenCalled();
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
  const { env, origin, namespace } = createEnv(session, { allowlisted: sourceIp });
  const request = new Request("https://site.test/home", {
    headers: { "CF-Connecting-IP": sourceIp },
  });

  const response = await worker.fetch(request, env);

  expect(await response.text()).toBe("origin-ok");
  expect(origin.fetch).toHaveBeenCalledWith(request);
  expect(namespace.get).not.toHaveBeenCalled();
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
    state: { ...createSnapshot("maze"), mazeRequests: budget },
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

it("throttles at the configured response budget with the bounded decoy", async () => {
  const session = createSession("maze");
  session.recordMazeRequest.mockImplementation(async (budget: number) => ({
    state: {
      ...createSnapshot("maze"),
      mazeRequests: budget,
      throttledRequests: 1,
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
