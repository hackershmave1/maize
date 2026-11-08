import { handleLure, isLureRequest } from "./lures";
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
}

const DEFAULT_RESPONSE_BUDGET = 100;
const MAZE_DECOY_BODY = '{"error":"Not found"}';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const lureRequest = isLureRequest(request, env);
    const sourceIp = normalizeSourceIp(request.headers.get("CF-Connecting-IP"));
    const allowlisted = sourceIp !== null && isAllowlisted(sourceIp, env);

    if (allowlisted) {
      return lureRequest
        ? (await handleLure(request, env)).response
        : env.ORIGIN.fetch(request);
    }

    if (sourceIp === null) {
      return lureRequest
        ? (await handleLure(request, env)).response
        : env.ORIGIN.fetch(request);
    }

    let session: AgentSessionStub;
    let mode: AgentSessionSnapshot;
    try {
      session = await getAgentSession(sourceIp, env);
      mode = await session.getMode();
    } catch {
      reportStateError();
      return lureRequest
        ? (await handleLure(request, env)).response
        : env.ORIGIN.fetch(request);
    }

    if (mode.mode === "blocked") return blockedResponse();
    if (mode.mode === "maze") {
      if (lureRequest) await handleLure(request, env);
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
      return result.response;
    }

    return env.ORIGIN.fetch(request);
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
