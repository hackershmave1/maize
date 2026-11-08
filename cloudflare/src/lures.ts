import type { Env } from "./index";

const KEY_CONTEXT = new TextEncoder().encode("moqesh-lure-api-key-v1");

export type LureRoute = "env-file" | "bait-api";

export interface LureEvent {
  type: "lure";
  route: LureRoute;
  source: string | null;
  confirmed: boolean;
}

export interface LureAlert {
  type: "direct-lure" | "confirmation";
  route: LureRoute;
  source: string;
}

export interface LureResult {
  response: Response;
  event: LureEvent;
  alert?: LureAlert;
}

export interface LureOptions {
  enabled?: boolean;
  allowlisted?: boolean;
}

export function isLureRequest(request: Request, env: Env): boolean {
  const { pathname } = new URL(request.url);
  return pathname === "/.env" || pathname === env.BAIT_API_PATH;
}

export async function handleLure(
  request: Request,
  env: Env,
  options: LureOptions = {},
): Promise<LureResult> {
  const path = new URL(request.url).pathname;
  const route: LureRoute = path === "/.env" ? "env-file" : "bait-api";
  const source = request.headers.get("CF-Connecting-IP");
  const event: LureEvent = {
    type: "lure",
    route,
    source,
    confirmed: false,
  };
  const allowlisted = options.allowlisted ?? (source !== null
    && (env.ALLOWLISTED_SOURCES ?? "")
      .split(",")
      .some((candidate) => candidate.trim() === source));

  if (options.enabled === false) {
    return {
      response: new Response("Not found", {
        status: 404,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      }),
      event,
    };
  }

  if (route === "env-file") {
    if (!env.LURE_KEY_SECRET || !env.BAIT_API_PATH) {
      return {
        response: new Response("Not found", { status: 404 }),
        event,
      };
    }

    const key = await deriveSyntheticKey(env.LURE_KEY_SECRET);
    const apiUrl = new URL(env.BAIT_API_PATH, new URL(request.url).origin);
    const response = new Response(
      `API_KEY=${key}\nAPI_BASE_URL=${apiUrl.toString()}\n`,
      {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
    if (allowlisted && source !== null && env.ALERT_DIRECT_LURE === "true") {
      return {
        response,
        event,
        alert: {
          type: "direct-lure",
          route,
          source,
        },
      };
    }
    return { response, event };
  }

  const confirmed = env.LURE_KEY_SECRET
    ? await isValidAuthorization(request.headers.get("Authorization"), env.LURE_KEY_SECRET)
    : false;
  event.confirmed = confirmed;
  if (!confirmed) {
    return {
      response: unauthorizedDecoy(),
      event,
    };
  }

  const response = Response.json(
    {
      data: { id: "synthetic-account", status: "active" },
      readonly: true,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
  if (allowlisted && source !== null && env.ALERT_CONFIRMATION === "true") {
    return {
      response,
      event,
      alert: {
        type: "confirmation",
        route,
        source,
      },
    };
  }
  return {
    response,
    event,
  };
}

async function deriveSyntheticKey(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, KEY_CONTEXT),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function isValidAuthorization(
  authorization: string | null,
  secret: string,
): Promise<boolean> {
  const match = /^Bearer ([a-f\d]{64})$/i.exec(authorization ?? "");
  if (!match) return false;

  const signature = new Uint8Array(32);
  for (let index = 0; index < signature.length; index += 1) {
    signature[index] = Number.parseInt(match[1].slice(index * 2, index * 2 + 2), 16);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, KEY_CONTEXT);
}

function unauthorizedDecoy(): Response {
  return Response.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
