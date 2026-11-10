import { expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  AgentSessionState,
  AgentSession,
  type AgentSessionSnapshot,
  type DurableObjectSessionState,
  type SessionStorage,
} from "../src/agent-session";
import {
  deriveAgentSessionName,
  normalizeSourceIp,
} from "../src/session-state";

class MemoryStorage implements SessionStorage {
  private readonly values = new Map<string, unknown>();
  private transactionTail: Promise<void> = Promise.resolve();
  writes = 0;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.writes += 1;
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async transaction<T>(callback: (storage: SessionStorage) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback(this);
    } finally {
      release();
    }
  }
}

function createSession(now: () => number) {
  const state: DurableObjectSessionState = {
    storage: new MemoryStorage(),
  };
  return new AgentSessionState(state.storage, now);
}

const minute = 60_000;
const mazeDuration = 15 * minute;
const blockDuration = 24 * 60 * minute;

async function snapshot(session: AgentSessionState): Promise<AgentSessionSnapshot> {
  return session.getMode();
}

it("starts with ordinary mode and empty counters", async () => {
  const storage = new MemoryStorage();
  const session = new AgentSessionState(storage, () => 1_000);

  await expect(snapshot(session)).resolves.toEqual({
    mode: "ordinary",
    confirmedAt: null,
    mazeUntil: null,
    blockUntil: null,
    mazeRequests: 0,
    throttledRequests: 0,
    chainDepth: 0,
  });
  expect(storage.writes).toBe(0);
});

it("starts the maze only on the first valid key reuse", async () => {
  let now = 10_000;
  const session = createSession(() => now);

  const confirmed = await session.confirmKeyReuse();
  now += minute;
  const repeated = await session.confirmKeyReuse();

  expect(confirmed).toMatchObject({
    mode: "maze",
    confirmedAt: 10_000,
    mazeUntil: 10_000 + mazeDuration,
    blockUntil: 10_000 + mazeDuration + blockDuration,
  });
  expect(repeated).toEqual(confirmed);
});

it("remains in maze before the 15-minute window expires", async () => {
  let now = 0;
  const session = createSession(() => now);
  await session.confirmKeyReuse();

  now = mazeDuration - 1;
  await expect(snapshot(session)).resolves.toMatchObject({ mode: "maze" });
});

it("blocks after the maze window until the 24-hour block expires", async () => {
  let now = 0;
  const session = createSession(() => now);
  await session.confirmKeyReuse();

  now = mazeDuration;
  await expect(snapshot(session)).resolves.toMatchObject({ mode: "blocked" });
  now = mazeDuration + blockDuration - 1;
  await expect(snapshot(session)).resolves.toMatchObject({ mode: "blocked" });
});

it("clears expired quarantine state after the 24-hour block", async () => {
  let now = 0;
  const session = createSession(() => now);
  await session.confirmKeyReuse();

  now = mazeDuration + blockDuration;
  await expect(snapshot(session)).resolves.toEqual({
    mode: "ordinary",
    confirmedAt: null,
    mazeUntil: null,
    blockUntil: null,
    mazeRequests: 0,
    throttledRequests: 0,
    chainDepth: 0,
  });
});

it("throttles at the configured response budget without changing quarantine timers", async () => {
  let now = 5_000;
  const session = createSession(() => now);
  const started = await session.confirmKeyReuse();

  const first = await session.recordMazeRequest(2);
  const second = await session.recordMazeRequest(2);
  now += minute;
  const third = await session.recordMazeRequest(2);

  expect(first).toMatchObject({ throttled: false, state: { mazeRequests: 1 } });
  expect(second).toMatchObject({ throttled: true, state: { mazeRequests: 2, throttledRequests: 1 } });
  expect(third).toMatchObject({ throttled: true, state: { mazeRequests: 3, throttledRequests: 2 } });
  expect(third.state.confirmedAt).toBe(started.confirmedAt);
  expect(third.state.mazeUntil).toBe(started.mazeUntil);
  expect(third.state.blockUntil).toBe(started.blockUntil);
});

it("serializes concurrent key reuse and maze counter updates", async () => {
  const session = createSession(() => 10_000);

  const confirmations = await Promise.all(
    Array.from({ length: 50 }, () => session.confirmKeyReuse()),
  );
  const results = await Promise.all(
    Array.from({ length: 100 }, () => session.recordMazeRequest(5)),
  );
  const finalState = await snapshot(session);

  expect(new Set(confirmations.map((item) => item.confirmedAt)).size).toBe(1);
  expect(finalState).toMatchObject({
    mode: "maze",
    confirmedAt: 10_000,
    mazeRequests: 100,
    throttledRequests: 96,
  });
  expect(results.filter((item) => item.throttled)).toHaveLength(96);
});

it("serializes concurrent calls in the local Durable Object runtime", async () => {
  const namespace = (env as unknown as {
    AGENT_SESSIONS: {
      newUniqueId(): unknown;
      get(id: unknown): AgentSession;
    };
  }).AGENT_SESSIONS;
  const session = namespace.get(namespace.newUniqueId());

  await Promise.all(
    Array.from({ length: 25 }, () => session.confirmKeyReuse()),
  );
  await Promise.all(
    Array.from({ length: 50 }, () => session.recordMazeRequest(10)),
  );
  const finalState = await session.getMode();

  expect(finalState).toMatchObject({
    mode: "maze",
    mazeRequests: 50,
    throttledRequests: 41,
  });
});

it("unblocks a source and clears the persisted counters", async () => {
  const session = createSession(() => 1_000);
  await session.confirmKeyReuse();
  await session.recordMazeRequest(1);

  await expect(session.unblock()).resolves.toEqual({
    mode: "ordinary",
    confirmedAt: null,
    mazeUntil: null,
    blockUntil: null,
    mazeRequests: 0,
    throttledRequests: 0,
    chainDepth: 0,
  });
});

it("normalizes IPv4 and IPv6 source addresses before they are used as state keys", () => {
  expect(normalizeSourceIp(" 203.0.113.7 ")).toBe("203.0.113.7");
  expect(normalizeSourceIp("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
  expect(normalizeSourceIp("::ffff:192.0.2.1")).toBe("::ffff:c000:201");
  expect(normalizeSourceIp("not-an-ip")).toBeNull();
});

it("derives stable, installation-scoped, non-reversible state identifiers", async () => {
  const first = await deriveAgentSessionName(
    "installation-a",
    "2001:db8::1",
    "state-hash-secret",
  );
  const normalizedVariant = await deriveAgentSessionName(
    "installation-a",
    "2001:0db8:0:0:0:0:0:1",
    "state-hash-secret",
  );
  const otherSource = await deriveAgentSessionName(
    "installation-a",
    "2001:db8::2",
    "state-hash-secret",
  );
  const otherInstallation = await deriveAgentSessionName(
    "installation-b",
    "2001:db8::1",
    "state-hash-secret",
  );

  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(normalizedVariant).toBe(first);
  expect(first).not.toContain("2001");
  expect(otherSource).not.toBe(first);
  expect(otherInstallation).not.toBe(first);
});
it("records chain depth 1 on confirmation and advances hop by hop", async () => {
  const session = createSession(() => 0);
  await expect(session.confirmKeyReuse()).resolves.toMatchObject({ chainDepth: 1 });

  await expect(session.advanceChain(2, blockDuration)).resolves.toMatchObject({
    accepted: true,
    state: { mode: "maze", chainDepth: 2 },
  });
  await expect(session.advanceChain(2, blockDuration)).resolves.toMatchObject({ accepted: true });
  await expect(session.advanceChain(4, blockDuration)).resolves.toMatchObject({
    accepted: false,
    state: { chainDepth: 2 },
  });
});

it("blocks immediately after the final hop", async () => {
  const session = createSession(() => 5_000);
  await session.confirmKeyReuse();
  for (let hop = 2; hop < 10; hop += 1) await session.advanceChain(hop, blockDuration);

  await expect(session.advanceChain(10, blockDuration)).resolves.toMatchObject({
    accepted: true,
    state: { mode: "blocked", chainDepth: 10, mazeUntil: 5_000, blockUntil: 5_000 + blockDuration },
  });
});

it("rejects chain hops outside maze mode", async () => {
  const session = createSession(() => 0);
  await expect(session.advanceChain(2, blockDuration)).resolves.toMatchObject({ accepted: false });
});

it("reads stored state from before chain depth existed as depth 0", async () => {
  const storage = new MemoryStorage();
  await storage.put("session", {
    confirmedAt: 0,
    mazeUntil: mazeDuration,
    blockUntil: mazeDuration + blockDuration,
    mazeRequests: 0,
    throttledRequests: 0,
  });
  const session = new AgentSessionState(storage, () => 1);
  await expect(session.getMode()).resolves.toMatchObject({ mode: "maze", chainDepth: 0 });
  await expect(session.advanceChain(2, blockDuration)).resolves.toMatchObject({ accepted: false });
});

it("re-confirming a legacy maze session raises depth to 1 without moving its timers", async () => {
  const storage = new MemoryStorage();
  const legacy = {
    confirmedAt: 0,
    mazeUntil: mazeDuration,
    blockUntil: mazeDuration + blockDuration,
    mazeRequests: 3,
    throttledRequests: 0,
  };
  await storage.put("session", legacy);
  const session = new AgentSessionState(storage, () => 1);

  await expect(session.confirmKeyReuse()).resolves.toMatchObject({ ...legacy, mode: "maze", chainDepth: 1 });
  await expect(session.advanceChain(2, blockDuration)).resolves.toMatchObject({ accepted: true });
});
