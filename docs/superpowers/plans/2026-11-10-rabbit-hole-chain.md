# Rabbit-Hole Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a source reuses the leaked key, lead it through 10 fake API hops (each leaking the next endpoint and token), then block it.

**Architecture:** A pure `src/rabbit-hole.ts` module defines hops, HMAC-derived hop tokens, and responses. The per-IP Durable Object records the deepest hop (`chainDepth`) and blocks immediately after hop 10. In maze mode, `src/index.ts` serves valid chain requests instead of the maze `404`. D1 migration 0005 adds the `rabbit_hole_hop` event type and `hop-2`…`hop-10` routes.

**Tech Stack:** TypeScript Cloudflare Worker, Durable Objects, D1, Vitest with `@cloudflare/vitest-plugin`, Node `node:test`, Python 3 `unittest`, Terraform 1.10.5 (HCP, local execution).

Spec: `docs/superpowers/specs/2026-11-10-rabbit-hole-chain-design.md`.

Run commands from `cloudflare/` in your feature worktree, except Python commands, which run from the repository root.

---

## File map

- Create `cloudflare/src/rabbit-hole.ts`: hop table, `CHAIN_LENGTH`, `ChainRoute`, `CHAIN_HOPS`, `hopToken`, `matchChainHop`, `renderHop`.
- Create `cloudflare/test/rabbit-hole.test.ts`.
- Modify `cloudflare/src/session-state.ts`: add `chainDepth` and `ChainAdvanceResult`.
- Modify `cloudflare/src/agent-session.ts`: set the depth on confirmation; add `advanceChain`.
- Modify `cloudflare/test/agent-session.test.ts`.
- Create `cloudflare/migrations/0005_rabbit_hole_events.sql`.
- Modify `cloudflare/src/events.ts`: event type and route union.
- Modify `cloudflare/terraform/scripts/apply-d1-migrations.mjs`, `cloudflare/terraform/test/deployment-scripts.node.mjs`, `cloudflare/test/admin-api.test.ts`.
- Modify `cloudflare/src/lures.ts`: the hop 1 response comes from `renderHop(1, …)`.
- Modify `cloudflare/src/index.ts`: maze-mode chain handling.
- Modify `cloudflare/test/worker.test.ts`, `cloudflare/test/lures.test.ts`.
- Modify `cloudflare/scripts/demo_attack.py`, `cloudflare/test/demo_attack_test.py`.
- Modify `cloudflare/README.md`, `.github/prompts/maize-cloudflare-deploy.prompt.md`, `cloudflare/test/staging-acceptance.md`.

---

### Task 1: Rabbit-hole module

**Files:**
- Create: `cloudflare/src/rabbit-hole.ts`
- Test: `cloudflare/test/rabbit-hole.test.ts`

- [ ] **Step 1: Write the failing test** (`test/rabbit-hole.test.ts`)

```ts
import { expect, it } from "vitest";
import {
  CHAIN_HOPS,
  CHAIN_LENGTH,
  hopToken,
  matchChainHop,
  renderHop,
} from "../src/rabbit-hole";

const secret = "unit-test-verifier-material";
const origin = "https://site.test";

it("defines ten hops with unique paths after the bait API", () => {
  expect(CHAIN_LENGTH).toBe(10);
  expect(CHAIN_HOPS.map((hop) => hop.number)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(new Set(CHAIN_HOPS.map((hop) => hop.path)).size).toBe(9);
  expect(CHAIN_HOPS.map((hop) => hop.route)).toEqual(
    [2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `hop-${n}`),
  );
});

it("derives distinct deterministic 64-hex tokens per hop", async () => {
  const tokens = await Promise.all([2, 3, 10].map((n) => hopToken(secret, n)));
  expect(tokens.every((token) => /^[a-f0-9]{64}$/.test(token))).toBe(true);
  expect(new Set(tokens).size).toBe(3);
  expect(await hopToken(secret, 2)).toBe(tokens[0]);
  expect(await hopToken("other-secret", 2)).not.toBe(tokens[0]);
});

it("each hop below ten leaks the next endpoint and its token", async () => {
  for (let hop = 1; hop < CHAIN_LENGTH; hop += 1) {
    const body = await (await renderHop(hop, origin, secret)).json() as {
      data: unknown;
      next: { endpoint: string; authorization: string };
    };
    const next = CHAIN_HOPS.find((candidate) => candidate.number === hop + 1)!;
    expect(body.data).toBeTruthy();
    expect(body.next.endpoint).toBe(`${origin}${next.path}`);
    expect(body.next.authorization).toBe(`Bearer ${await hopToken(secret, hop + 1)}`);
  }
});

it("the final hop has data and no next lead", async () => {
  const response = await renderHop(CHAIN_LENGTH, origin, secret);
  const body = await response.json() as Record<string, unknown>;
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(body.data).toBeTruthy();
  expect(body.next).toBeUndefined();
});

it("renders the same hop identically and keeps hostnames on example.invalid", async () => {
  const first = await (await renderHop(8, origin, secret)).text();
  const second = await (await renderHop(8, origin, secret)).text();
  expect(first).toBe(second);
  const hosts = [...first.matchAll(/"host":"([^"]+)"/g)].map((match) => match[1]);
  expect(hosts.length).toBeGreaterThan(0);
  expect(hosts.every((host) => host.endsWith(".example.invalid"))).toBe(true);
});

it("matches a hop only with its own bearer token", async () => {
  const hop3 = CHAIN_HOPS.find((hop) => hop.number === 3)!;
  const request = (token: string | null, path = hop3.path) => new Request(`${origin}${path}`, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });

  expect(await matchChainHop(request(await hopToken(secret, 3)), secret)).toBe(3);
  expect(await matchChainHop(request(await hopToken(secret, 4)), secret)).toBeNull();
  expect(await matchChainHop(request(null), secret)).toBeNull();
  expect(await matchChainHop(request("zz"), secret)).toBeNull();
  expect(await matchChainHop(request(await hopToken(secret, 3), "/nope"), secret)).toBeNull();
  expect(await matchChainHop(request(await hopToken(secret, 3)), undefined)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rabbit-hole.test.ts`
Expected: FAIL, cannot resolve `../src/rabbit-hole`.

- [ ] **Step 3: Write the implementation** (`src/rabbit-hole.ts`)

```ts
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
```

The HMAC output is 64 hex characters, so every `fake()` length must be 64 or less. All lengths above are.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rabbit-hole.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/rabbit-hole.ts test/rabbit-hole.test.ts
git commit -m "feat: add deterministic ten-hop rabbit-hole chain"
```

---

### Task 2: Chain depth in the per-IP session

**Files:**
- Modify: `cloudflare/src/session-state.ts`
- Modify: `cloudflare/src/agent-session.ts`
- Test: `cloudflare/test/agent-session.test.ts`

- [ ] **Step 1: Write the failing tests**

In "starts with ordinary mode and empty counters", add `chainDepth: 0,` to the expected object. Then append:

```ts
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
```

(`"session"` is `SESSION_KEY` in `src/agent-session.ts:28`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/agent-session.test.ts`
Expected: FAIL (`advanceChain` is not a function; `chainDepth` is missing).

- [ ] **Step 3: Implement**

In `src/session-state.ts`:
- Add `chainDepth: number;` to `PersistedSessionState`.
- Add `chainDepth: 0,` to `emptySessionState()`.
- Append:

```ts
export interface ChainAdvanceResult {
  accepted: boolean;
  state: AgentSessionSnapshot;
}
```

In `src/agent-session.ts`:
- Add `import { CHAIN_LENGTH } from "./rabbit-hole";`, and add `type ChainAdvanceResult` to the `./session-state` import.
- In `confirmKeyReuse`, add `chainDepth: 1,` to the new-confirmation object (next to `throttledRequests: 0`).
- In `read`, replace the first two lines with:

```ts
    const stored = await storage.get<Partial<PersistedSessionState>>(SESSION_KEY);
    const state = expireSessionState(
      { ...emptySessionState(), ...(stored ?? {}) },
      currentTime,
    );
```

- Add to `AgentSessionState`, after `recordMazeRequest`:

```ts
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
```

- Add to the `AgentSession` class:

```ts
  advanceChain(hop: number, blockDurationMs?: number): Promise<ChainAdvanceResult> {
    return this.session.advanceChain(hop, blockDurationMs);
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/agent-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-state.ts src/agent-session.ts test/agent-session.test.ts
git commit -m "feat: track rabbit-hole depth and block after the final hop"
```

---

### Task 3: Hop events and migration 0005

**Files:**
- Create: `cloudflare/migrations/0005_rabbit_hole_events.sql`
- Modify: `cloudflare/src/events.ts`
- Modify: `cloudflare/terraform/scripts/apply-d1-migrations.mjs:7-12,117`
- Modify: `cloudflare/terraform/test/deployment-scripts.node.mjs:108-113` (plus a new test)
- Modify: `cloudflare/test/admin-api.test.ts:16-20,43`

- [ ] **Step 1: Write the failing tests**

In `terraform/test/deployment-scripts.node.mjs`:
- Add `"0005_rabbit_hole_events.sql",` after `"0004_more_lure_routes.sql",` in the expected `migrationNames`.
- Append:

```js
nodeTest("migration 0005 preserves events and accepts rabbit-hole hop events", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  for (const name of ["0001_events.sql", "0002_admin.sql", "0003_containment_sources.sql", "0004_more_lure_routes.sql"]) {
    database.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  }
  database.prepare(
    "INSERT INTO events (id, installation_id, type, route, source_ip, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("existing", "install", "unconfirmed_lure_view", "config-json", "192.0.2.1", 0, 1);

  database.exec(await readFile(new URL("../../migrations/0005_rabbit_hole_events.sql", import.meta.url), "utf8"));

  assert.deepEqual(
    { ...database.prepare("SELECT id, route FROM events").get() },
    { id: "existing", route: "config-json" },
  );
  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'").all()
    .map(({ name }) => name).filter((name) => !name.startsWith("sqlite_"));
  assert.deepEqual(indexes.sort(), ["events_created_idx", "events_installation_created_idx"]);
  const insert = database.prepare(
    "INSERT INTO events (id, installation_id, type, route, source_ip, confirmed, created_at) VALUES (?, 'install', ?, ?, NULL, 1, 2)",
  );
  for (let hop = 2; hop <= 10; hop += 1) insert.run(`hop-${hop}`, "rabbit_hole_hop", `hop-${hop}`);
  insert.run("still-lure", "confirmed_reuse", "bait-api");
  assert.throws(() => insert.run("bad-route", "rabbit_hole_hop", "hop-11"), /CHECK constraint failed/);
  assert.throws(() => insert.run("bad-type", "not_a_type", null), /CHECK constraint failed/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run -s test:deployment`
Expected: FAIL (the 0005 file is missing; the migration-name list differs).

- [ ] **Step 3: Implement**

Create `migrations/0005_rabbit_hole_events.sql`:

```sql
-- SQLite cannot alter CHECK constraints, so rebuild events with rabbit-hole hop events.
CREATE TABLE events_v5 (
  id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'unconfirmed_lure_view',
    'invalid_key_attempt',
    'confirmed_reuse',
    'rabbit_hole_hop',
    'block'
  )),
  route TEXT CHECK (route IS NULL OR route IN (
    'env-file',
    'env-production',
    'git-config',
    'aws-credentials',
    'config-json',
    'wp-config-backup',
    'sql-backup',
    'api-keys',
    'swagger',
    'bait-api',
    'hop-2',
    'hop-3',
    'hop-4',
    'hop-5',
    'hop-6',
    'hop-7',
    'hop-8',
    'hop-9',
    'hop-10'
  )),
  source_ip TEXT,
  confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
  created_at INTEGER NOT NULL
);

INSERT INTO events_v5 (id, installation_id, type, route, source_ip, confirmed, created_at)
  SELECT id, installation_id, type, route, source_ip, confirmed, created_at FROM events;

DROP TABLE events;

ALTER TABLE events_v5 RENAME TO events;

CREATE INDEX IF NOT EXISTS events_installation_created_idx
  ON events (installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at);
```

In `terraform/scripts/apply-d1-migrations.mjs`:
- Add `"0005_rabbit_hole_events.sql",` after the 0004 entry in `REQUIRED_MIGRATIONS`.
- Change the log line to `"Verified D1 migrations 0001 through 0005 and initialized runtime settings"`.

In `src/events.ts`:
- Add `import type { ChainRoute } from "./rabbit-hole";`.
- Add `| "rabbit_hole_hop"` to `EventType`.
- In `EventInput`, change `route: LureRoute | null;` to `route: LureRoute | ChainRoute | null;`.

In `test/admin-api.test.ts`:
- Add `import rabbitHoleSchema from "../migrations/0005_rabbit_hole_events.sql?raw";`.
- Append `rabbitHoleSchema` to the schema array in `beforeAll`.

- [ ] **Step 4: Run tests**

Run: `npm run -s test:deployment && npx vitest run test/admin-api.test.ts test/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/0005_rabbit_hole_events.sql src/events.ts terraform/scripts/apply-d1-migrations.mjs terraform/test/deployment-scripts.node.mjs test/admin-api.test.ts
git commit -m "feat: add rabbit-hole hop events with migration 0005"
```

---

### Task 4: Serve the chain from the Worker

**Files:**
- Modify: `cloudflare/src/lures.ts` (confirmed bait response, ~line 240)
- Modify: `cloudflare/src/index.ts` (stub interface ~33, maze branch ~159-177, `persistEvent` route type)
- Test: `cloudflare/test/worker.test.ts`, `cloudflare/test/lures.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/lures.test.ts`, in "confirms a valid key from Authorization…", after the existing `body` expectations, add:

```ts
  const parsed = JSON.parse(body) as { data: { id: string }; next: { endpoint: string; authorization: string } };
  expect(parsed.data.id).toMatch(/^acct_[a-f0-9]{12}$/);
  expect(parsed.next.endpoint).toBe("https://lure.test/api/private/billing");
  expect(parsed.next.authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
```

In `test/worker.test.ts`:
- Add `import { CHAIN_HOPS, hopToken } from "../src/rabbit-hole";`.
- Replace `createSession` with this stateful fake:

```ts
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
```

- Append:

```ts
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
  const { env, origin } = createEnv(createSession("maze"));
  const lure = await worker.fetch(new Request("https://site.test/.env"), env);
  const key = (await lure.text()).match(/^API_KEY=(.+)$/m)![1];
  const response = await worker.fetch(hopRequest(baitApiPath, key), env);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { next: { endpoint: string } }).next.endpoint)
    .toBe(`https://site.test${CHAIN_HOPS[0].path}`);
  expect(origin.fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/worker.test.ts test/lures.test.ts`
Expected: FAIL. The bait response has no `next`, and in maze mode hop paths return 404.

- [ ] **Step 3: Implement**

In `src/lures.ts`:
- Add `import { renderHop } from "./rabbit-hole";`.
- Replace the confirmed `const response = Response.json({ data: { id: "synthetic-account", … } }, …);` with:

```ts
  // `confirmed` is only true when LURE_KEY_SECRET is set.
  const response = await renderHop(1, new URL(request.url).origin, env.LURE_KEY_SECRET!);
```

In `src/index.ts`:
1. Add `import { matchChainHop, renderHop, type ChainRoute } from "./rabbit-hole";`, and add `type ChainAdvanceResult` to the `./session-state` import.
2. Add `advanceChain(hop: number, blockDurationMs?: number): Promise<ChainAdvanceResult>;` to `AgentSessionStub`.
3. In `persistEvent`'s parameter type, change `route: LureRoute | null;` to `route: LureRoute | ChainRoute | null;`.
4. Replace the whole `if (mode.mode === "maze") { … }` block with:

```ts
    if (mode.mode === "maze") {
      const currentSettings = settings ?? await runtimeSettings(env);
      if (lureRequest) {
        const result = await handleLure(request, env, {
          allowlisted: false,
          enabled: currentSettings.luresEnabled,
        });
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
```

- [ ] **Step 4: Run the Worker suite and typecheck**

Run: `npx vitest run && npm run -s typecheck`
Expected: all tests pass, no type errors. The existing maze test "serves decoys for every route during maze…" must still pass: its `/.env` has no key, so it is not confirmed.

- [ ] **Step 5: Commit**

```bash
git add src/lures.ts src/index.ts test/worker.test.ts test/lures.test.ts
git commit -m "feat: lead contained sources through the rabbit-hole chain"
```

---

### Task 5: Demo script walks the chain

**Files:**
- Modify: `cloudflare/scripts/demo_attack.py`
- Test: `cloudflare/test/demo_attack_test.py`

New flow (16 requests, each behind its own `NEXT`):
1. NORMAL VISITOR: `/` returns 200 with the runner.
2. MISSING CREDENTIAL: `BAIT_PATH` returns 401.
3. DISCOVER THE BAIT: `/.env` returns the key.
4. REUSE THE SYNTHETIC KEY: `BAIT_PATH` returns 200 with `data` and a `next` lead to `HOP_PATHS[0]`.
5. VERIFY MAZE DIVERSION: `/` returns 404.
6. FOLLOW THE RABBIT HOLE: hops 2–10, each previewed and gated. Hops 2–9 must lead to the next fixed path; hop 10 must have no `next`.
7. VERIFY BLOCK: `/` returns 403.
8. OPERATOR UNBLOCK AND RECOVERY: `/` returns the runner after a manual unblock.

Request indexes: 0 `/`, 1 bait, 2 `.env`, 3 bait, 4 `/`, 5–13 hops, 14 `/` (403), 15 `/` (runner).

- [ ] **Step 1: Write the failing tests**

Replace `responses()` in `test/demo_attack_test.py`:

```python
TOKEN = "Bearer " + "b" * 64


def lead(index):
    return {"endpoint": demo.BASE_URL + demo.HOP_PATHS[index], "authorization": TOKEN}


def hop_body(index):
    body = {"data": {"hop": index + 2}, "readonly": True}
    if index + 1 < len(demo.HOP_PATHS):
        body["next"] = lead(index + 1)
    return json.dumps(body)


def responses():
    return [
        demo.Response(200, {"Content-Type": "text/html"}, "<title>Signal Sprint</title>"),
        demo.Response(401, {}, '{"error":"Unauthorized"}'),
        demo.Response(200, {}, f"API_KEY={KEY}\nAPI_BASE_URL={demo.BASE_URL}/api/private/account\n"),
        demo.Response(200, {}, json.dumps({"data": {"id": "acct_demo"}, "readonly": True, "next": lead(0)})),
        demo.Response(404, {}, '{"error":"Not found"}'),
        *[demo.Response(200, {}, hop_body(index)) for index in range(len(demo.HOP_PATHS))],
        demo.Response(403, {}, "Forbidden"),
        demo.Response(200, {"Content-Type": "text/html"}, "<title>Signal Sprint</title>"),
    ]
```

(Add `import json` at the top.)

Update `test_walkthrough_previews_each_request_and_requires_six_approvals`:
- Rename it to `test_walkthrough_previews_each_request_and_requires_sixteen_approvals`.
- Expected paths become `["/", "/api/private/account", "/.env", "/api/private/account", "/", *demo.HOP_PATHS, "/", "/"]`.
- Assert the approval count is `16` and that `STAGE {n}/8` appears for n = 1–8.
- Replace `"synthetic-account"` in the expected text with `"HOP 10/10"`, and add `"HTTP 403"`.
- Add `self.assertEqual(requests[5][2]["Authorization"], TOKEN)`.

In `test_missing_containment_and_failed_unblock_are_explicit_failures`, replace the loop with:

```python
        for index, stage, wrong in [(4, 5, 0), (14, 7, 4), (15, 8, 4)]:
            with self.subTest(stage=stage):
                replies = responses()
                replies[index] = replies[wrong]
                request = Mock(side_effect=replies)
                with self.assertRaisesRegex(demo.DemoError, f"STAGE {stage}"):
                    demo.run_demo(input_fn=lambda _: "NEXT", output=lambda _: None, request_fn=request)
                self.assertEqual(request.call_count, index + 1)
```

Append:

```python
    def test_chain_refuses_leads_outside_the_fixed_staging_chain(self):
        bad_leads = [
            {"endpoint": "https://example.invalid" + demo.HOP_PATHS[1], "authorization": TOKEN},
            {"endpoint": demo.BASE_URL + "/api/other", "authorization": TOKEN},
            {"endpoint": demo.BASE_URL + demo.HOP_PATHS[1], "authorization": "Bearer short"},
        ]
        for bad in bad_leads:
            with self.subTest(lead=bad):
                replies = responses()
                replies[5] = demo.Response(200, {}, json.dumps({"data": {}, "next": bad}))
                request = Mock(side_effect=replies)
                with self.assertRaises(demo.DemoError):
                    demo.run_demo(input_fn=lambda _: "NEXT", output=lambda _: None, request_fn=request)
                self.assertEqual(request.call_count, 6)

    def test_final_hop_offering_another_lead_is_a_failure(self):
        replies = responses()
        replies[13] = demo.Response(200, {}, json.dumps({"data": {}, "next": lead(0)}))
        request = Mock(side_effect=replies)
        with self.assertRaises(demo.DemoError):
            demo.run_demo(input_fn=lambda _: "NEXT", output=lambda _: None, request_fn=request)
        self.assertEqual(request.call_count, 14)

    def test_transport_allows_only_known_hop_paths(self):
        self.assertTrue(set(demo.HOP_PATHS) <= demo.ALLOWED_PATHS)
        with self.assertRaises(demo.DemoError):
            demo.send_request("/api/internal/other", {})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest cloudflare/test/demo_attack_test.py`
Expected: FAIL (`demo.HOP_PATHS` is undefined).

- [ ] **Step 3: Implement** (in `scripts/demo_attack.py`)

- Add after `TRACE_PATH`:

```python
HOP_PATHS = (
    "/api/private/billing",
    "/api/private/team",
    "/api/private/admin/users",
    "/api/private/admin/keys",
    "/api/internal/services",
    "/api/internal/deploy/secrets",
    "/api/internal/db/credentials",
    "/api/internal/backups",
    "/api/internal/vault/root",
)
ALLOWED_PATHS = frozenset({"/", "/.env", BAIT_PATH, TRACE_PATH, *HOP_PATHS})
LEAD_TOKEN = re.compile(r"Bearer [a-f0-9]{64}")
```

  (Add `import re` if it is missing.)
- In `send_request`, replace the path set with `if path not in ALLOWED_PATHS:`.
- Add:

```python
def next_lead(response: Response, expected_path: str) -> str:
    body = json_body(response)
    lead = body.get("next") if isinstance(body, dict) else None
    if not isinstance(lead, dict) or lead.get("endpoint") != BASE_URL + expected_path:
        raise DemoError("Rabbit-hole lead is missing or points outside the fixed staging chain; stopping.")
    authorization = lead.get("authorization")
    if not isinstance(authorization, str) or LEAD_TOKEN.fullmatch(authorization) is None:
        raise DemoError("Rabbit-hole lead has a malformed bearer token; stopping.")
    return authorization
```

- Restructure `run_demo`:
  - Keep the stage tuples for stages 1–5, then stages 7 and 8, numbered out of 8.
  - Insert the rabbit-hole loop as stage 6, between stage 5 and stage 7.
  - Keep a shared `base_headers = {"Accept": "*/*", "User-Agent": "Moqesh-Staging-Demo/1.0"}`.
  - Stage 4 validation becomes `response.status == 200 and isinstance(json_body(response), dict) and "data" in json_body(response)`, then `authorization = next_lead(response, HOP_PATHS[0])`. A `DemoError` from `next_lead` must use the `STAGE 4` prefix: catch it and re-raise with the stage label.
  - Stage 5 validation: 404 decoy.
  - Stage 7 validation: `response.status == 403`.
  - Stage 8: runner HTML.
  - The stage 6 block:

```python
    output(
        f"\n{'=' * 68}\nSTAGE 6/8: FOLLOW THE RABBIT HOLE\n"
        "Expected: each hop returns HTTP 200 fake data with the next lead; hop 10 has no lead and "
        "blocks this source."
    )
    for index, path in enumerate(HOP_PATHS):
        hop = index + 2
        headers = {**base_headers, "Authorization": authorization}
        output(f"\n--- HOP {hop}/10 REQUEST PREVIEW ---\nGET {BASE_URL}{path}")
        for name, value in headers.items():
            output(f"{name}: {value}")
        output("Request body: (none)")
        approve(input_fn, output)
        response = request_fn(path, headers)
        show_response(response, output)
        if response.status != 200 or response.truncated:
            raise DemoError(f"STAGE 6 HOP {hop}: expected HTTP 200 fake data; stopping.")
        if index + 1 < len(HOP_PATHS):
            authorization = next_lead(response, HOP_PATHS[index + 1])
        else:
            body = json_body(response)
            if not isinstance(body, dict) or "next" in body:
                raise DemoError("STAGE 6 HOP 10: final hop unexpectedly offered another lead; stopping.")
    output(
        "\nSTAGE 6 PASSED. Operator checkpoint: In Detections, refresh to see rabbit hole hop "
        "events hop-2 through hop-10. In Containment, the source is now blocked."
    )
```

  - Update the closing summary to: "ordinary browsing -> rejected missing key -> bait discovery -> confirmed reuse -> maze diversion -> 10-hop rabbit hole -> block -> operator unblock -> normal browsing restored."
  - Update the opening warning: containment is the maze until the chain ends or 15 minutes pass, then a 24-hour block.

- [ ] **Step 4: Run tests and lint**

```bash
python3 -m unittest cloudflare/test/demo_attack_test.py
uv tool run ruff check cloudflare/scripts cloudflare/test/demo_attack_test.py
uv tool run ruff format --check cloudflare/scripts cloudflare/test/demo_attack_test.py
```

Expected: all pass. If the format check fails, run `uv tool run ruff format` on those files and re-run.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/scripts/demo_attack.py cloudflare/test/demo_attack_test.py
git commit -m "feat: walk the ten-hop rabbit hole in the guided demo"
```

---

### Task 6: Docs and full local validation

**Files:**
- Modify: `cloudflare/README.md`
- Modify: `.github/prompts/maize-cloudflare-deploy.prompt.md`

- [ ] **Step 1: Update the docs**

Find the spots with `grep -n "0004\|synthetic-account\|STAGE\|Stage 5" cloudflare/README.md .github/prompts/maize-cloudflare-deploy.prompt.md`. Then:
- **README traffic model:** after key reuse, describe the 10-hop chain (list the hop paths) and that the source is blocked immediately after hop 10. Within the maze, the real site still returns 404.
- **README migrations:** list 0005 (rabbit-hole hop events) after 0004.
- **README demo section:** 8 stages; stage 6 walks 9 hops, each needing `NEXT`; stage 7 expects 403.
- **Prompt file:** change "0001 through 0004" to "0001 through 0005", and mention the chain wherever the lures are listed.

- [ ] **Step 2: Full local validation**

```bash
npx vitest run
npm run -s typecheck
npm run -s test:deployment
npm run -s test:staging-origin
npm run -s check:bindings
npm run -s build
```

From the repository root, run `python3 -m unittest cloudflare/test/demo_attack_test.py`.
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add cloudflare/README.md .github/prompts/maize-cloudflare-deploy.prompt.md
git commit -m "docs: describe the rabbit-hole chain and migration 0005"
```

---

### Task 7: Staging deploy (operator approval gate)

- [ ] **Step 1: Plan**

From `cloudflare/terraform`, load your protected deployment environment, as in the README's local-execution section. Then:

```bash
terraform plan -var-file=staging.tfvars -out=rabbit.tfplan
sha256sum rabbit.tfplan
```

Expected changes:
- Update in place: `cloudflare_workers_script.app`.
- Replace: the `terraform_data` resources for D1 migrations, Worker secrets and staging-origin ownership.
- No changes to routes, DNS, Access or zone settings.
- No Durable Object migration (`agent_session_migration_applied = true`).

- [ ] **Step 2: STOP.** Show the operator the plan summary and the SHA-256. Apply only after the operator explicitly approves that hash.

- [ ] **Step 3: Apply**

```bash
echo "<approved-hash>  rabbit.tfplan" | sha256sum -c - && terraform apply rabbit.tfplan
```

- [ ] **Step 4: Live verification**
  - D1: the migration ledger contains 0005, and the event row count is unchanged.
  - From the operator's browser (the same IP throughout):
    1. Get the key from `/config.json`.
    2. Reuse it: the response includes `next`.
    3. `/` returns 404.
    4. Follow hops 2–10: each returns 200, and hop 10 has no `next`.
    5. `/` returns 403.
  - The operator confirms in the dashboard that Detections lists `rabbit hole hop` events for `hop-2` to `hop-10`, then unblocks the IP.

- [ ] **Step 5: Record the evidence**

Add a "Rabbit-hole chain (2026-11-10)" section to `cloudflare/test/staging-acceptance.md` with the plan hash, the apply result and the live observations. Commit.
