import { DurableObject } from "cloudflare:workers";
import { CHAIN_LENGTH } from "./rabbit-hole";
import {
  BLOCK_DURATION_MS,
  MAZE_DURATION_MS,
  emptySessionState,
  expireSessionState,
  snapshotSessionState,
  type AgentSessionSnapshot,
  type ChainAdvanceResult,
  type MazeRequestResult,
  type PersistedSessionState,
} from "./session-state";

export interface SessionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  transaction<T>(callback: (storage: SessionStorage) => Promise<T>): Promise<T>;
}

export interface DurableObjectSessionState {
  storage: SessionStorage;
}

export interface AgentSessionEnvironment {
  now?: () => number;
}

const SESSION_KEY = "session";

export class AgentSessionState {
  private readonly now: () => number;
  constructor(
    private readonly storage: SessionStorage,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  async getMode(): Promise<AgentSessionSnapshot> {
    return this.storage.transaction(async (storage) => {
      const currentTime = this.now();
      const state = await this.read(storage, currentTime);
      return snapshotSessionState(state, currentTime);
    });
  }

  async confirmKeyReuse(
    mazeDurationMs = MAZE_DURATION_MS,
    blockDurationMs = BLOCK_DURATION_MS,
  ): Promise<AgentSessionSnapshot> {
    return this.storage.transaction(async (storage) => {
      const currentTime = this.now();
      const current = await this.read(storage, currentTime);
      const state = current.confirmedAt === null
        ? {
          ...current,
          confirmedAt: currentTime,
          mazeUntil: currentTime + mazeDurationMs,
          blockUntil: currentTime + mazeDurationMs + blockDurationMs,
          mazeRequests: 0,
          throttledRequests: 0,
          chainDepth: 1,
        }
        : current;
      await storage.put(SESSION_KEY, state);
      return snapshotSessionState(state, currentTime);
    });
  }

  async recordMazeRequest(responseBudget: number): Promise<MazeRequestResult> {
    return this.storage.transaction(async (storage) => {
      const currentTime = this.now();
      const current = await this.read(storage, currentTime);
      if (snapshotSessionState(current, currentTime).mode !== "maze") {
        return {
          state: snapshotSessionState(current, currentTime),
          throttled: false,
        };
      }

      const state: PersistedSessionState = {
        ...current,
        mazeRequests: current.mazeRequests + 1,
      };
      const budget = Number.isFinite(responseBudget)
        ? Math.max(1, Math.floor(responseBudget))
        : 1;
      const throttled = state.mazeRequests >= budget;
      if (throttled) state.throttledRequests += 1;
      await storage.put(SESSION_KEY, state);
      return {
        state: snapshotSessionState(state, currentTime),
        throttled,
      };
    });
  }

  async advanceChain(
    hop: number,
    blockDurationMs = BLOCK_DURATION_MS,
  ): Promise<ChainAdvanceResult> {
    return this.storage.transaction(async (storage) => {
      const currentTime = this.now();
      const current = await this.read(storage, currentTime);
      const snapshot = snapshotSessionState(current, currentTime);
      if (
        snapshot.mode !== "maze"
        || !Number.isInteger(hop)
        || hop < 2
        || hop > CHAIN_LENGTH
        || hop > current.chainDepth + 1
      ) {
        return { accepted: false, state: snapshot };
      }
      const state: PersistedSessionState = {
        ...current,
        chainDepth: Math.max(current.chainDepth, hop),
        ...(hop === CHAIN_LENGTH
          ? { mazeUntil: currentTime, blockUntil: currentTime + blockDurationMs }
          : {}),
      };
      await storage.put(SESSION_KEY, state);
      return { accepted: true, state: snapshotSessionState(state, currentTime) };
    });
  }

  async unblock(): Promise<AgentSessionSnapshot> {
    return this.storage.transaction(async (storage) => {
      await storage.delete(SESSION_KEY);
      return snapshotSessionState(emptySessionState(), this.now());
    });
  }

  private async read(
    storage: SessionStorage,
    currentTime: number,
  ): Promise<PersistedSessionState> {
    const stored = await storage.get<Partial<PersistedSessionState>>(SESSION_KEY);
    const state = expireSessionState(
      { ...emptySessionState(), ...(stored ?? {}) },
      currentTime,
    );
    if (stored && state.confirmedAt === null) {
      await storage.put(SESSION_KEY, state);
    }
    return state;
  }
}

export class AgentSession extends DurableObject<AgentSessionEnvironment> {
  private readonly session: AgentSessionState;

  constructor(
    state: DurableObjectSessionState,
    env: AgentSessionEnvironment = {},
  ) {
    super(state, env);
    this.session = new AgentSessionState(state.storage, env.now ?? Date.now);
  }

  getMode(): Promise<AgentSessionSnapshot> {
    return this.session.getMode();
  }

  confirmKeyReuse(
    mazeDurationMs?: number,
    blockDurationMs?: number,
  ): Promise<AgentSessionSnapshot> {
    return this.session.confirmKeyReuse(mazeDurationMs, blockDurationMs);
  }

  recordMazeRequest(responseBudget: number): Promise<MazeRequestResult> {
    return this.session.recordMazeRequest(responseBudget);
  }

  advanceChain(hop: number, blockDurationMs?: number): Promise<ChainAdvanceResult> {
    return this.session.advanceChain(hop, blockDurationMs);
  }

  unblock(): Promise<AgentSessionSnapshot> {
    return this.session.unblock();
  }
}

export {
  BLOCK_DURATION_MS,
  MAZE_DURATION_MS,
  type AgentSessionSnapshot,
  type MazeRequestResult,
  type PersistedSessionState,
} from "./session-state";
