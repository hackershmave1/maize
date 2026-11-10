export const CHAIN_LENGTH = 10;

export type ChainRoute =
  | "hop-2" | "hop-3" | "hop-4" | "hop-5" | "hop-6"
  | "hop-7" | "hop-8" | "hop-9" | "hop-10";

type Fake = (label: string, length?: number) => string;

interface HopDefinition {
  path: string;
  // Describes the lead this hop gives to the next hop.
  lead: string;
  data: (fake: Fake) => Record<string, unknown>;
}

const CONTEXT = "moqesh-rabbit-hole-v1";
const ISSUED = "2026-10-02T08:14:00Z";

// Index 0 is hop 1 (the configured bait API path); indexes 1..9 are hops 2..10.
const HOPS: HopDefinition[] = [
  {
    path: "",
    lead: "Billing profile for this account",
    data: (fake) => ({
      id: `acct_${fake("account", 12)}`,
      name: "Northwind Ops",
      plan: "enterprise",
      owner: "ops-lead@northwind.example.invalid",
      created: ISSUED,
    }),
  },
  {
    path: "/api/private/billing",
    lead: "Team directory (requires billing scope)",
    data: (fake) => ({
      customer: `cus_${fake("customer", 14)}`,
      card: { brand: "visa", last4: "4242", expires: "08/28" },
      invoices: [1, 2, 3].map((n) => ({
        id: `inv_${fake(`invoice-${n}`, 10)}`,
        amount: 4_800 * n,
        status: "paid",
      })),
    }),
  },
  {
    path: "/api/private/team",
    lead: "Admin user management",
    data: (fake) => ({
      members: ["m.levin", "a.cohen", "r.dahan", "s.weiss"].map((user, index) => ({
        id: `usr_${fake(`member-${index}`, 8)}`,
        email: `${user}@northwind.example.invalid`,
        role: index === 0 ? "owner" : "member",
      })),
    }),
  },
  {
    path: "/api/private/admin/users",
    lead: "Service API keys for admin users",
    data: (fake) => ({
      admins: ["m.levin", "ops-break-glass"].map((user, index) => ({
        id: `adm_${fake(`admin-${index}`, 8)}`,
        username: user,
        mfa: index === 0 ? "totp" : "disabled",
        last_login: ISSUED,
      })),
    }),
  },
  {
    path: "/api/private/admin/keys",
    lead: "Internal service inventory",
    data: (fake) => ({
      keys: ["ci-deployer", "metrics-reader", "legacy-sync"].map((name) => ({
        name,
        key_id: `key_${fake(`key-id-${name}`, 10)}`,
        secret: `nw_${fake(`key-secret-${name}`, 32)}`,
        scopes: name === "ci-deployer" ? ["deploy", "read"] : ["read"],
      })),
    }),
  },
  {
    path: "/api/internal/services",
    lead: "Deploy pipeline secrets",
    data: () => ({
      services: ["api-gateway", "billing-worker", "auth-service", "report-builder"].map((name, index) => ({
        name,
        host: `${name}.internal.northwind.example.invalid`,
        port: 8080 + index,
        owner: "platform",
      })),
    }),
  },
  {
    path: "/api/internal/deploy/secrets",
    lead: "Primary database credentials",
    data: (fake) => ({
      pipeline: "prod-release",
      variables: {
        REGISTRY_TOKEN: fake("registry", 40),
        SIGNING_KEY_ID: `sig_${fake("signing", 12)}`,
        CHAT_WEBHOOK_PATH: `/hooks/${fake("chat", 24)}`,
      },
    }),
  },
  {
    path: "/api/internal/db/credentials",
    lead: "Backup manifest for the primary database",
    data: (fake) => ({
      primary: {
        host: "db-primary.internal.northwind.example.invalid",
        port: 5432,
        user: "app_rw",
        password: fake("db-password", 28),
      },
      replica: {
        host: "db-replica.internal.northwind.example.invalid",
        port: 5432,
        user: "app_ro",
        password: fake("db-replica-password", 28),
      },
    }),
  },
  {
    path: "/api/internal/backups",
    lead: "Root vault export",
    data: (fake) => ({
      backups: [1, 2, 3].map((n) => ({
        id: `bkp_${fake(`backup-${n}`, 10)}`,
        host: "backups.northwind.example.invalid",
        object: `nightly/2026-10-0${n}/primary.sql.gz`,
        size_bytes: 1_840_000_000 + n * 7_311,
      })),
    }),
  },
  {
    path: "/api/internal/vault/root",
    lead: "",
    data: (fake) => ({
      sealed: false,
      root_token: `vault_${fake("vault-root", 40)}`,
      unseal_keys: [1, 2, 3].map((n) => fake(`unseal-${n}`, 44)),
      host: "vault.internal.northwind.example.invalid",
    }),
  },
];

export const CHAIN_HOPS: readonly { number: number; path: string; route: ChainRoute }[] =
  HOPS.slice(1).map((hop, index) => ({
    number: index + 2,
    path: hop.path,
    route: `hop-${index + 2}` as ChainRoute,
  }));

export function hopToken(secret: string, hop: number): Promise<string> {
  return hmacHex(secret, `${CONTEXT}\u0000hop-${hop}`);
}

export async function matchChainHop(
  request: Request,
  secret: string | undefined,
): Promise<number | null> {
  if (!secret) return null;
  const { pathname } = new URL(request.url);
  const hop = CHAIN_HOPS.find((candidate) => candidate.path === pathname);
  if (!hop) return null;
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) return null;
  return constantTimeEqual(match[1], await hopToken(secret, hop.number)) ? hop.number : null;
}

export async function renderHop(hop: number, origin: string, secret: string): Promise<Response> {
  const definition = HOPS[hop - 1];
  if (!definition) throw new Error(`Unknown rabbit-hole hop ${hop}`);
  // Collect the labels first, derive them with HMAC (async), then build the data synchronously.
  const labels: string[] = [];
  definition.data((label) => {
    labels.push(label);
    return "";
  });
  const derived = new Map<string, string>();
  for (const label of labels) {
    derived.set(label, await hmacHex(secret, `${CONTEXT}\u0000fake\u0000${label}`));
  }
  const data = definition.data((label, length = 24) => (derived.get(label) ?? "").slice(0, length));
  const body: Record<string, unknown> = { data, readonly: true };
  if (hop < CHAIN_LENGTH) {
    body.next = {
      description: definition.lead,
      endpoint: new URL(HOPS[hop].path, origin).toString(),
      authorization: `Bearer ${await hopToken(secret, hop + 1)}`,
    };
  }
  return Response.json(body, {
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
