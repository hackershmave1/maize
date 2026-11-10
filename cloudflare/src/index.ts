import { handleLure, isLureRequest, robotsTxt } from "./lures";
import { matchChainHop, renderHop, type ChainRoute } from "./rabbit-hole";
import {
  deleteExpiredAdminAudit,
  deleteExpiredContainmentSources,
  handleAdminApiRequest,
  isRuntimeAllowlisted,
  persistContainmentSource,
  readRuntimeSettings,
  validateAccessAssertion,
  type AdminActor,
  type RuntimeSettings,
} from "./admin-api";
import {
  deleteExpiredOutbox,
  deliverOutbox,
  enqueueAlertWithEvent,
  processPendingAlerts,
} from "./alerts";
import {
  deleteExpiredEvents,
  recordEvent,
  type EventDatabase,
  type EventInput,
  type EventType,
} from "./events";
import {
  deriveAgentSessionName,
  normalizeSourceIp,
  type AgentSessionSnapshot,
  type ChainAdvanceResult,
  type MazeRequestResult,
} from "./session-state";

interface AgentSessionStub {
  getMode(): Promise<AgentSessionSnapshot>;
  unblock(): Promise<AgentSessionSnapshot>;
  confirmKeyReuse(
    mazeDurationMs?: number,
    blockDurationMs?: number,
  ): Promise<AgentSessionSnapshot>;
  recordMazeRequest(responseBudget: number): Promise<MazeRequestResult>;
  advanceChain(hop: number, blockDurationMs?: number): Promise<ChainAdvanceResult>;
}

interface AgentSessionNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): AgentSessionStub;
}

interface WorkerAssets {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  ORIGIN?: {
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
  ALERT_WEBHOOK_ENABLED?: string;
  EVENTS_DB?: EventDatabase;
  ALERT_WEBHOOK_URL?: string;
  ADMIN_HOSTNAME?: string;
  ADMIN_ROUTE?: string;
  PUBLIC_SITE_HOSTNAME?: string;
  PUBLIC_ROUTE?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ASSETS?: WorkerAssets;
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
const DAY_MS = 24 * 60 * 60 * 1_000;

export default {
  async fetch(
    request: Request,
    env: Env,
    context?: WorkerExecutionContext,
  ): Promise<Response> {
    const requestUrl = new URL(request.url);
    const hostname = requestUrl.hostname.toLowerCase();
    const adminHostname = env.ADMIN_HOSTNAME?.trim().toLowerCase();
    const isAdminApi = requestUrl.pathname === "/api/admin"
      || requestUrl.pathname.startsWith("/api/admin/");
    if (isAdminApi) {
      if (!adminHostname || hostname !== adminHostname || requestUrl.protocol !== "https:") {
        return adminErrorResponse(404, "Not found");
      }
      const actor = await authenticatedActor(request, env);
      if (!actor) return adminErrorResponse(401, "Authentication required");
      return handleAdminApiRequest(request, env, actor);
    }
    if (adminHostname && hostname === adminHostname) {
      if (requestUrl.protocol !== "https:") {
        return adminErrorResponse(404, "Not found");
      }
      const actor = await authenticatedActor(request, env);
      if (!actor) return adminErrorResponse(401, "Authentication required");
      if (!env.ASSETS) return adminErrorResponse(404, "Dashboard assets unavailable");
      try {
        return await serveDashboardAsset(request, env.ASSETS);
      } catch {
        console.error("Admin dashboard asset request failed");
        return adminErrorResponse(503, "Dashboard unavailable");
      }
    }

    const lureRequest = isLureRequest(request, env);
    const sourceIp = normalizeSourceIp(request.headers.get("CF-Connecting-IP"));
    const allowlisted = sourceIp !== null && await isAllowlisted(sourceIp, env);
    const settings = lureRequest ? await runtimeSettings(env) : undefined;
    if (lureRequest && settings?.luresEnabled === false) {
      const disabled = await handleLure(request, env, { enabled: false });
      return disabled.response;
    }

    if (allowlisted) {
      if (!lureRequest) return forwardToOrigin(request, env);
      return serveLure(request, env, context, allowlisted, settings);
    }

    if (sourceIp === null) {
      if (!lureRequest) return forwardToOrigin(request, env);
      return serveLure(request, env, context, false, settings);
    }

    let session: AgentSessionStub;
    let mode: AgentSessionSnapshot;
    try {
      session = await getAgentSession(sourceIp, env);
      mode = await session.getMode();
    } catch {
      reportStateError();
      return lureRequest
        ? serveLure(request, env, context, false, settings)
        : forwardToOrigin(request, env);
    }

    if (mode.mode === "blocked") {
      await reconcileContainmentSource(sourceIp, mode, env);
      await persistBlockEvent(sourceIp, env);
      return blockedResponse();
    }
    if (mode.mode === "maze") {
      const currentSettings = settings ?? await runtimeSettings(env);
      if (lureRequest) {
        const result = await handleLure(request, env, {
          allowlisted: false,
          enabled: currentSettings.luresEnabled,
        });
        if (result.event.confirmed) {
          try {
            await session.confirmKeyReuse(
              currentSettings.mazeDurationMinutes * 60_000,
              currentSettings.blockDurationHours * 60 * 60_000,
            );
          } catch {
            reportStateError();
          }
        }
        await persistLureResult(result, env, context, currentSettings);
        if (result.event.confirmed) return result.response;
      }
      const hop = await matchChainHop(request, env.LURE_KEY_SECRET);
      if (hop !== null) {
        try {
          const advanced = await session.advanceChain(
            hop,
            currentSettings.blockDurationHours * 60 * 60_000,
          );
          if (advanced.accepted) {
            await persistEvent({
              installationId: env.INSTALLATION_ID,
              type: "rabbit_hole_hop",
              route: `hop-${hop}` as ChainRoute,
              sourceIp,
              confirmed: true,
            }, env);
            if (advanced.state.mode === "blocked") {
              await reconcileContainmentSource(sourceIp, advanced.state, env);
            }
            // matchChainHop only matches when LURE_KEY_SECRET is set.
            return renderHop(hop, requestUrl.origin, env.LURE_KEY_SECRET!);
          }
        } catch {
          reportStateError();
        }
      }
      let throttled = false;
      try {
        const result = await session.recordMazeRequest(currentSettings.responseBudget);
        throttled = result.throttled;
      } catch {
        reportStateError();
      }
      return throttled ? cachedMazeThrottleResponse() : mazeResponse(false);
    }

    if (lureRequest) {
      const currentSettings = settings ?? await runtimeSettings(env);
      const result = await handleLure(request, env, {
        allowlisted: false,
        enabled: currentSettings.luresEnabled,
      });
      let containmentUntil: number | undefined;
      if (result.event.confirmed) {
        try {
          const confirmed = await session.confirmKeyReuse(
            currentSettings.mazeDurationMinutes * 60_000,
            currentSettings.blockDurationHours * 60 * 60_000,
          );
          containmentUntil = confirmed.blockUntil ?? undefined;
        } catch {
          reportStateError();
        }
      }
      await persistLureResult(result, env, context, currentSettings, containmentUntil);
      return result.response;
    }

    return forwardToOrigin(request, env);
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
    const settings = await runtimeSettings(env);
    const retentionMs = settings.retentionDays * DAY_MS;
    context.waitUntil(Promise.all([
      deleteExpiredEvents(database, Date.now(), retentionMs).catch(() => {
        console.error("D1 event retention cleanup failed");
      }),
      deleteExpiredAdminAudit(database, Date.now(), retentionMs).catch(() => {
        console.error("D1 admin audit retention cleanup failed");
      }),
      ...(env.INSTALLATION_ID
        ? [deleteExpiredContainmentSources(database, env.INSTALLATION_ID).catch(() => {
          console.error("D1 containment index cleanup failed");
        })]
        : []),
      deleteExpiredOutbox(database, Date.now(), retentionMs).catch(() => {
        console.error("D1 webhook outbox retention cleanup failed");
      }),
      ...(env.ALERT_WEBHOOK_ENABLED === "false"
        ? []
        : [processPendingAlerts(database, env.ALERT_WEBHOOK_URL).catch(() => {
            console.error("D1 webhook retry processing failed");
          })]),
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

async function isAllowlisted(sourceIp: string, env: Env): Promise<boolean> {
  const configured = (env.ALLOWLISTED_SOURCES ?? "")
    .split(",")
    .some((candidate) => normalizeSourceIp(candidate) === sourceIp);
  if (configured) return true;
  try {
    return await isRuntimeAllowlisted(env.EVENTS_DB, env.INSTALLATION_ID, sourceIp);
  } catch {
    console.error("Allowlist lookup failed; continuing with containment checks");
    return false;
  }
}

async function reconcileContainmentSource(
  sourceIp: string,
  state: AgentSessionSnapshot,
  env: Env,
): Promise<void> {
  if (
    state.confirmedAt === null
    || state.blockUntil === null
    || !env.EVENTS_DB
    || !env.INSTALLATION_ID
  ) {
    return;
  }
  try {
    await persistContainmentSource(
      env.EVENTS_DB,
      env.INSTALLATION_ID,
      sourceIp,
      state.confirmedAt,
      state.blockUntil,
    );
  } catch {
    console.error("D1 containment source persistence failed");
  }
}

function responseBudget(env: Env): number {
  const configured = Number.parseInt(env.MAZE_RESPONSE_BUDGET ?? "", 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_RESPONSE_BUDGET;
}

async function runtimeSettings(env: Env): Promise<RuntimeSettings> {
  return readRuntimeSettings(
    env.EVENTS_DB,
    env.INSTALLATION_ID,
    {
      luresEnabled: true,
      mazeDurationMinutes: 15,
      blockDurationHours: 24,
      responseBudget: responseBudget(env),
      alertGroupingMinutes: 5,
      retentionDays: 30,
    },
  );
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

function forwardToOrigin(request: Request, env: Env): Promise<Response> | Response {
  if (new URL(request.url).pathname === "/robots.txt") {
    return new Response(robotsTxt(env), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (env.ORIGIN) return env.ORIGIN.fetch(request);
  // DNS-origin mode: a same-zone subrequest goes to the proxied origin server
  // without re-invoking this Worker. Only the protected hostname may be forwarded.
  const publicHostname = env.PUBLIC_SITE_HOSTNAME?.trim().toLowerCase();
  if (!publicHostname || new URL(request.url).hostname.toLowerCase() !== publicHostname) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return fetch(request);
}

async function serveLure(
  request: Request,
  env: Env,
  context?: WorkerExecutionContext,
  allowlisted = false,
  settings?: RuntimeSettings,
): Promise<Response> {
  const currentSettings = settings ?? await runtimeSettings(env);
  const result = await handleLure(request, env, {
    enabled: currentSettings.luresEnabled,
    allowlisted,
  });
  if (currentSettings.luresEnabled) {
    await persistLureResult(result, env, context, currentSettings);
  }
  return result.response;
}

async function persistLureResult(
  result: Awaited<ReturnType<typeof handleLure>>,
  env: Env,
  context?: WorkerExecutionContext,
  settings: RuntimeSettings = {
    luresEnabled: true,
    mazeDurationMinutes: 15,
    blockDurationHours: 24,
    responseBudget: DEFAULT_RESPONSE_BUDGET,
    alertGroupingMinutes: 5,
    retentionDays: 30,
  },
  containmentUntil?: number,
): Promise<void> {
  if (
    containmentUntil !== undefined
    && result.event.confirmed
    && result.event.source
    && env.INSTALLATION_ID
    && env.EVENTS_DB
  ) {
    try {
      await persistContainmentSource(
        env.EVENTS_DB,
        env.INSTALLATION_ID,
        result.event.source,
        Date.now(),
        containmentUntil,
      );
    } catch {
      console.error("D1 containment source persistence failed");
    }
  }
  const eventType: EventType = result.event.confirmed
    ? "confirmed_reuse"
    : result.event.route === "bait-api"
    ? "invalid_key_attempt"
    : "unconfirmed_lure_view";
  const event: Omit<EventInput, "installationId"> & { installationId: string | undefined } = {
    installationId: env.INSTALLATION_ID,
    type: eventType,
    route: result.event.route,
    sourceIp: result.event.source,
    confirmed: result.event.confirmed,
  };
  if (!result.alert) {
    await persistEvent(event, env);
    return;
  }
  if (env.ALERT_WEBHOOK_ENABLED === "false") {
    await persistEvent(event, env);
    return;
  }
  const installationId = env.INSTALLATION_ID;
  if (!env.EVENTS_DB || !installationId) {
    console.error("D1 event storage is unavailable; alert was not persisted");
    return;
  }

  let queued;
  try {
    queued = await enqueueAlertWithEvent(
      env.EVENTS_DB,
      { ...event, installationId },
      result.alert,
      Date.now(),
      settings.alertGroupingMinutes * 60_000,
    );
  } catch {
    console.error("D1 event and webhook outbox transaction failed; alert was not dispatched");
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
    route: EventInput["route"];
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

async function authenticatedActor(
  request: Request,
  env: Env,
): Promise<AdminActor | null> {
  try {
    return await validateAccessAssertion(request, env);
  } catch {
    console.error("Admin identity verification failed");
    return null;
  }
}

function adminErrorResponse(status: number, message: string): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'self'",
        "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    },
  );
}

async function serveDashboardAsset(
  request: Request,
  assets: WorkerAssets,
): Promise<Response> {
  const response = await assets.fetch(request);
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
