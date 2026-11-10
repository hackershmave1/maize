# Rabbit-hole chain design

Date: 2026-11-10. Status: approved by operator.

## Goal

Keep a confirmed attacker busy longer. Today, reusing the leaked key at the
bait API returns a tiny `synthetic-account` record and then everything
returns the maze `404`. Instead, the bait API starts a chain of 10 fake API
hops. Each hop returns plausible fake data and leaks the next endpoint plus a
new bearer token. After the 10th hop is served, the source is blocked at once.
While inside the chain, the source cannot reach the real staging site.

## Flow per source IP

1. Hop 0 (unchanged): a disclosure lure leaks the synthetic key and the bait
   API URL.
2. Hop 1: `Bearer <synthetic key>` at `BAIT_API_PATH` confirms the source and
   starts the maze, as today. The response is now a fake account record that
   includes a lead to hop 2.
3. Hops 2–10 are fixed paths:

   | Hop | Path | Content |
   |---|---|---|
   | 1 | `BAIT_API_PATH` (`/api/private/account`) | account profile |
   | 2 | `/api/private/billing` | invoices, payment method summary |
   | 3 | `/api/private/team` | team members and roles |
   | 4 | `/api/private/admin/users` | admin users, MFA state |
   | 5 | `/api/private/admin/keys` | service API keys |
   | 6 | `/api/internal/services` | internal service inventory |
   | 7 | `/api/internal/deploy/secrets` | deploy pipeline secrets |
   | 8 | `/api/internal/db/credentials` | database connection details |
   | 9 | `/api/internal/backups` | backup manifests |
   | 10 | `/api/internal/vault/root` | "root" vault export (final hop) |

4. Each hop N (1–9) response includes a `next` lead:
   `{"description", "endpoint": <absolute URL>, "authorization": "Bearer <token N+1>"}`.
5. Hop 10 is served normally, then the source switches straight to blocked
   (`403`) for the configured block duration.

## Rules

- Hop token N = hex HMAC-SHA256(`LURE_KEY_SECRET`,
  `moqesh-rabbit-hole-v1\0hop-N`) for N = 2–10. Hop 1 keeps the existing
  synthetic key. Tokens are stateless and cannot be forged without the secret.
- Fake credential-like values inside hop data are also HMAC-derived, so the
  repository contains no secret-looking literals. All hostnames use
  `.example.invalid`. Data is deterministic per hop.
- Chain endpoints are served only while the source is in maze mode. In every
  other mode (ordinary, allowlisted, blocked) the hop paths behave as now
  (origin or `403`).
- In maze mode a hop N request is served only if the bearer token matches hop
  N and N is at most deepest-reached + 1. Revisiting an earlier hop is
  allowed. Any other request (wrong token, skipped hop, real site path) gets
  the existing maze `404` and counts toward the response budget.
- The 15-minute maze timer stays as a cap: a source that stalls is blocked
  when it expires.

## Components

- `src/rabbit-hole.ts` (new): hop table, token derivation, hop lookup by path,
  response rendering with the next lead. Pure and unit-testable.
- `src/session-state.ts` and `src/agent-session.ts`: persist
  `chainDepth` (default 0; set to 1 on confirmation). New Durable Object method
  `advanceChain(hop, blockDurationMs)` atomically checks the sequence rule,
  updates depth, and on hop 10 sets `mazeUntil = now` and
  `blockUntil = now + blockDuration`. Existing stored state without
  `chainDepth` reads as 0.
- `src/lures.ts`: the hop 1 response comes from the rabbit-hole renderer.
- `src/index.ts`: in maze mode, try the chain before the maze `404`; log each
  served hop 2–10; reconcile the containment source when hop 10 blocks.
- Events: new type `rabbit_hole_hop`, routes `hop-2` … `hop-10`. Hop 1 stays
  `confirmed_reuse` / `bait-api`. Migration
  `0005_rabbit_hole_events.sql` rebuilds `events` with the expanded type and
  route checks (same pattern as 0004); `apply-d1-migrations.mjs` requires it.
  The dashboard shows types and routes generically, so it needs no change.
- No Terraform route or `lure_paths` change: the existing `staging/*` route
  covers the hop paths, and hop paths are not disclosure lures.
- `scripts/demo_attack.py`: after key reuse, walk hops 2–10 with a `NEXT`
  gate per hop, then show that `/` returns `403`.

## Error handling

- Durable Object failure while advancing: report the state error and return
  the maze `404` (fail closed toward the attacker, never toward the origin).
- Missing `LURE_KEY_SECRET`: chain is disabled and maze behavior is unchanged.
- D1 write failure for a hop event: same best-effort handling as other events.

## Testing

- Unit: token derivation is deterministic and distinct per hop; each hop N
  < 10 contains the correct lead; no hop renders without the secret.
- Session state: sequence rule, revisits, skip rejection, hop 10 blocks,
  legacy state without `chainDepth`.
- Worker: full 10-hop walk; real path mid-chain returns `404`; wrong token
  returns `404`; request after hop 10 returns `403`; hop events are logged
  with the right routes; ordinary sources cannot use hop paths.
- Migration: 0005 applies on top of 0004 and keeps existing rows; deployment
  helper requires 0005.
- Demo script: hop walk is gated and only touches allowed paths.
- Live: walk the chain from the browser after the operator approves the
  Terraform plan.
