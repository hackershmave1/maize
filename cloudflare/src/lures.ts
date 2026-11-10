import type { Env } from "./index";
import { renderHop } from "./rabbit-hole";

const KEY_CONTEXT = new TextEncoder().encode("moqesh-lure-api-key-v1");

type DisclosureRenderer = (key: string, apiUrl: string, origin: string, baitPath: string) => string;

interface DisclosureLure {
  route: string;
  contentType: string;
  render: DisclosureRenderer;
}

const DISCLOSURE_LURES = {
  "/.env": {
    route: "env-file",
    contentType: "text/plain; charset=utf-8",
    render: (key, apiUrl) => `API_KEY=${key}\nAPI_BASE_URL=${apiUrl}\n`,
  },
  "/.env.production": {
    route: "env-production",
    contentType: "text/plain; charset=utf-8",
    render: (key, apiUrl) =>
      `NODE_ENV=production\nLOG_LEVEL=warn\nAPI_KEY=${key}\nAPI_BASE_URL=${apiUrl}\n`,
  },
  "/.git/config": {
    route: "git-config",
    contentType: "text/plain; charset=utf-8",
    render: (key, apiUrl) => [
      "[core]",
      "\trepositoryformatversion = 0",
      "\tfilemode = true",
      "\tbare = false",
      '[branch "main"]',
      "\tremote = origin",
      "\tmerge = refs/heads/main",
      "[account-api]",
      `\tendpoint = ${apiUrl}`,
      `\ttoken = ${key}`,
      "",
    ].join("\n"),
  },
  "/.aws/credentials": {
    route: "aws-credentials",
    contentType: "text/plain; charset=utf-8",
    render: (key, apiUrl) => [
      "[default]",
      "region = eu-west-1",
      "",
      "[account-api]",
      `api_key = ${key}`,
      `api_base_url = ${apiUrl}`,
      "",
    ].join("\n"),
  },
  "/config.json": {
    route: "config-json",
    contentType: "application/json",
    render: (key, apiUrl) =>
      JSON.stringify({ environment: "staging", api: { baseUrl: apiUrl, apiKey: key } }, null, 2),
  },
  "/wp-config.php.bak": {
    route: "wp-config-backup",
    contentType: "text/plain; charset=utf-8",
    render: (key, apiUrl) => [
      "<?php",
      "define( 'DB_NAME', 'wp_staging' );",
      "define( 'DB_HOST', 'localhost' );",
      `define( 'ACCOUNT_API_URL', '${apiUrl}' );`,
      `define( 'ACCOUNT_API_KEY', '${key}' );`,
      "$table_prefix = 'wp_';",
      "",
    ].join("\n"),
  },
  "/backup.sql": {
    route: "sql-backup",
    contentType: "application/sql; charset=utf-8",
    render: (key, apiUrl) => [
      "-- MySQL dump 10.13",
      "CREATE TABLE `api_keys` (`service` varchar(64), `endpoint` varchar(255), `token` char(64));",
      `INSERT INTO \`api_keys\` VALUES ('account-service','${apiUrl}','${key}');`,
      "",
    ].join("\n"),
  },
  "/api/v1/keys": {
    route: "api-keys",
    contentType: "application/json",
    render: (key, apiUrl) =>
      JSON.stringify({ keys: [{ name: "account-service", scopes: ["account:read"], endpoint: apiUrl, key }] }),
  },
  "/swagger.json": {
    route: "swagger",
    contentType: "application/json",
    render: (_key, _apiUrl, origin, baitPath) => JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Account Service", version: "1.4.2" },
      servers: [{ url: origin }],
      paths: {
        [baitPath]: {
          get: {
            summary: "Get the current account",
            security: [{ bearerAuth: [] }],
            responses: { "200": { description: "Account" }, "401": { description: "Unauthorized" } },
          },
        },
        "/api/v1/keys": { get: { summary: "List service API keys", responses: { "200": { description: "Keys" } } } },
      },
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    }),
  },
} as const satisfies Record<string, DisclosureLure>;

type DisclosurePath = keyof typeof DISCLOSURE_LURES;

export type LureRoute = (typeof DISCLOSURE_LURES)[DisclosurePath]["route"] | "bait-api";

export const LURE_ROUTES: readonly LureRoute[] = [
  ...Object.values(DISCLOSURE_LURES).map((lure) => lure.route as LureRoute),
  "bait-api",
];

function disclosureFor(pathname: string): (typeof DISCLOSURE_LURES)[DisclosurePath] | undefined {
  return Object.hasOwn(DISCLOSURE_LURES, pathname)
    ? DISCLOSURE_LURES[pathname as DisclosurePath]
    : undefined;
}

export function robotsTxt(env: Env): string {
  const paths = [...Object.keys(DISCLOSURE_LURES), ...(env.BAIT_API_PATH ? [env.BAIT_API_PATH] : [])];
  return `User-agent: *\n${paths.map((path) => `Disallow: ${path}\n`).join("")}`;
}

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
  return disclosureFor(pathname) !== undefined || pathname === env.BAIT_API_PATH;
}

export async function handleLure(
  request: Request,
  env: Env,
  options: LureOptions = {},
): Promise<LureResult> {
  const path = new URL(request.url).pathname;
  const disclosure = disclosureFor(path);
  const route: LureRoute = disclosure ? disclosure.route : "bait-api";
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

  if (disclosure) {
    if (!env.LURE_KEY_SECRET || !env.BAIT_API_PATH) {
      return {
        response: new Response("Not found", { status: 404 }),
        event,
      };
    }

    const key = await deriveSyntheticKey(env.LURE_KEY_SECRET);
    const origin = new URL(request.url).origin;
    const apiUrl = new URL(env.BAIT_API_PATH, origin);
    const response = new Response(
      disclosure.render(key, apiUrl.toString(), origin, env.BAIT_API_PATH),
      {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": disclosure.contentType,
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

  // `confirmed` is only true when LURE_KEY_SECRET is set.
  const response = await renderHop(1, new URL(request.url).origin, env.LURE_KEY_SECRET!);
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
