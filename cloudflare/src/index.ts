import { handleLure, isLureRequest } from "./lures";
import {
  deleteExpiredOutbox,
  deliverOutbox,
  enqueueAlert,
  processPendingAlerts,
} from "./alerts";
import {
  deleteExpiredEvents,
  recordEvent,
  type EventDatabase,
  type EventType,
} from "./events";
import {
  deriveAgentSessionName,
  normalizeSourceIp,
  type AgentSessionSnapshot,
  type MazeRequestResult,
} from "./session-state";

interface AgentSessionStub {
  getMode(): Promise<AgentSessionSnapshot>;
  confirmKeyReuse(): Promise<AgentSessionSnapshot>;
  recordMazeRequest(responseBudget: number): Promise<MazeRequestResult>;
}

interface AgentSessionNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): AgentSessionStub;
}

export interface Env {
  ORIGIN: {
    fetch(request: Request): Promise<Response>;
  };
  AGENT_SESSIONS?: AgentSessionNamespace;
  INSTALLATION_ID?: string;
  MAZE_RESPONSE_BUDGET?: string;
  LURE_KEY_SECRET?: string;
  BAIT_API_PATH?: string;
  ALLOWLISTED_SOURCES?: string;
  ALERT_DIRECT_LURE?: string;
  ALERT_CONFIRMATION?: string;
  EVENTS_DB?: EventDatabase;
  ALERT_WEBHOOK_URL?: string;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledControllerLike {
  scheduledTime: number;
  cron: string;
}

const DEFAULT_RESPONSE_BUDGET = 100;
const MAZE_DECOY_BODY = '{"error":"Not found"}';

export default {
  async fetch(
    request: Request,
    env: Env,
    context?: WorkerExecutionContext,
  ): Promise<Response> {
    const lureRequest = isLureRequest(request, env);
    const sourceIp = normalizeSourceIp(request.headers.get("CF-Connecting-IP"));
    const allowlisted = sourceIp !== null && isAllowlisted(sourceIp, env);

    if (allowlisted) {
      if (!lureRequest) return env.ORIGIN.fetch(request);
      return serveLure(request, env, context);
    }

    if (sourceIp === null) {
      if (!lureRequest) return env.ORIGIN.fetch(request);
      return serveLure(request, env, context);
    }

    let session: AgentSessionStub;
    let mode: AgentSessionSnapshot;
    try {
      session = await getAgentSession(sourceIp, env);
      mode = await session.getMode();
    } catch {
      reportStateError();
      return lureRequest
        ? serveLure(request, env, context)
        : env.ORIGIN.fetch(request);
    }

    if (mode.mode === "blocked") {
      await persistBlockEvent(sourceIp, env);
      return blockedResponse();
    }
    if (mode.mode === "maze") {
      if (lureRequest) {
        const result = await handleLure(request, env);
        await persistLureResult(result, env, context);
      }
      let throttled = false;
      try {
        const result = await session.recordMazeRequest(responseBudget(env));
        throttled = result.throttled;
      } catch {
        reportStateError();
      }
      return throttled ? cachedMazeThrottleResponse() : mazeResponse(false);
    }

    if (lureRequest) {
      const result = await handleLure(request, env);
      if (result.event.confirmed) {
        try {
          await session.confirmKeyReuse();
        } catch {
          reportStateError();
        }
      }
      await persistLureResult(result, env, context);
      return result.response;
    }

    return env.ORIGIN.fetch(request);
  },

  async scheduled(
    _controller: ScheduledControllerLike,
    env: Env,
    context: WorkerExecutionContext,
  ): Promise<void> {
    const database = env.EVENTS_DB;
    if (!database) {
      console.error("D1 event storage is unavailable; scheduled work was skipped");
      return;
    }
    context.waitUntil(Promise.all([
      deleteExpiredEvents(database).catch(() => {
        console.error("D1 event retention cleanup failed");
      }),
      deleteExpiredOutbox(database).catch(() => {
        console.error("D1 webhook outbox retention cleanup failed");
      }),
      processPendingAlerts(database, env.ALERT_WEBHOOK_URL).catch(() => {
        console.error("D1 webhook retry processing failed");
      }),
    ]).then(() => undefined));
  },
};

export { AgentSession } from "./agent-session";

async function getAgentSession(
  sourceIp: string,
  env: Env,
): Promise<AgentSessionStub> {
  if (!env.AGENT_SESSIONS || !env.INSTALLATION_ID || !env.LURE_KEY_SECRET) {
    throw new Error("Agent session state is not configured");
  }
  const name = await deriveAgentSessionName(
    env.INSTALLATION_ID,
    sourceIp,
    env.LURE_KEY_SECRET,
  );
  return env.AGENT_SESSIONS.get(env.AGENT_SESSIONS.idFromName(name));
}

function isAllowlisted(sourceIp: string, env: Env): boolean {
  return (env.ALLOWLISTED_SOURCES ?? "")
    .split(",")
    .some((candidate) => normalizeSourceIp(candidate) === sourceIp);
}

function responseBudget(env: Env): number {
  const configured = Number.parseInt(env.MAZE_RESPONSE_BUDGET ?? "", 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_RESPONSE_BUDGET;
}

function mazeResponse(throttled: boolean, body = MAZE_DECOY_BODY): Response {
  return new Response(body, {
    status: throttled ? 429 : 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...(throttled ? { "Retry-After": "30" } : {}),
    },
  });
}

async function cachedMazeThrottleResponse(): Promise<Response> {
  try {
    const cache = (globalThis.caches as CacheStorage & { default?: Cache })
      .default;
    if (!cache) throw new Error("Workers Cache API is unavailable");

    const key = new Request("https://moqesh-cache.invalid/maze-throttled-decoy");
    let decoy = await cache.match(key);
    if (!decoy) {
      decoy = new Response(MAZE_DECOY_BODY, {
        headers: {
          "Cache-Control": "public, max-age=30",
          "Content-Type": "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
      await cache.put(key, decoy.clone());
    }

    return mazeResponse(true, await decoy.text());
  } catch {
    console.error(
      "Maze decoy cache unavailable; using uncached throttled response",
    );
    return mazeResponse(true);
  }
}

function blockedResponse(): Response {
  return new Response("Forbidden", {
    status: 403,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function reportStateError(): void {
  console.error("Agent session state unavailable; using safe fallback");
}

async function serveLure(
  request: Request,
  env: Env,
  context?: WorkerExecutionContext,
): Promise<Response> {
  const result = await handleLure(request, env);
  await persistLureResult(result, env, context);
  return result.response;
}

async function persistLureResult(
  result: Awaited<ReturnType<typeof handleLure>>,
  env: Env,
  context?: WorkerExecutionContext,
): Promise<void> {
  const eventType: EventType = result.event.confirmed
    ? "confirmed_reuse"
    : result.event.route === "env-file"
    ? "unconfirmed_lure_view"
    : "invalid_key_attempt";
  const event = await persistEvent({
    installationId: env.INSTALLATION_ID,
    type: eventType,
    route: result.event.route,
    sourceIp: result.event.source,
    confirmed: result.event.confirmed,
  }, env);
  if (!event || !result.alert) return;

  let queued;
  try {
    queued = await enqueueAlert(env.EVENTS_DB!, event, result.alert);
  } catch {
    console.error("D1 webhook outbox persistence failed; alert was not dispatched");
    return;
  }
  if (!queued.dispatchImmediately) return;
  if (!context) {
    console.error("Execution context unavailable; alert remains pending for scheduled delivery");
    return;
  }
  context.waitUntil(
    deliverOutbox(
      env.EVENTS_DB!,
      queued.outboxId,
      env.ALERT_WEBHOOK_URL,
    ).catch(() => {
      console.error("D1 webhook delivery state update failed; alert remains in the outbox");
    }),
  );
}

async function persistBlockEvent(sourceIp: string, env: Env): Promise<void> {
  await persistEvent({
    installationId: env.INSTALLATION_ID,
    type: "block",
    route: null,
    sourceIp,
    confirmed: true,
  }, env);
}

async function persistEvent(
  input: {
    installationId: string | undefined;
    type: EventType;
    route: "env-file" | "bait-api" | null;
    sourceIp: string | null;
    confirmed: boolean;
  },
  env: Env,
) {
  if (!env.EVENTS_DB || !input.installationId) {
    console.error("D1 event storage is unavailable; event was not persisted");
    return null;
  }
  try {
    return await recordEvent(env.EVENTS_DB, {
      installationId: input.installationId,
      type: input.type,
      route: input.route,
      sourceIp: input.sourceIp,
      confirmed: input.confirmed,
    });
  } catch {
    console.error("D1 event persistence failed; preserving the existing Worker response");
    return null;
  }
}
