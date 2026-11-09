# Cloudflare Staging Acceptance Record

> **Status: NOT RUN.** This is a report template, not staging evidence. No
> Cloudflare resources have been provisioned or deployed. Complete only after
> the approved staging applies and tests have actually run. Record failures and
> skipped checks; do not infer staging success from local tests.

## Safety and evidence handling

- Use staging-only Cloudflare resources, state/workspace, tfvars, credentials,
  and secrets.
- Store approval references and sanitized summaries here, not saved Terraform
  plans/state, API tokens, secret values, full source IPs, event payloads, or
  other customer-sensitive data.
- For each acceptance step, label evidence as **local**, **staging**, or
  **not verified**. A local test is not a staging result.
- Every result in this template starts as **NOT RUN**. Keep local game/test
  evidence separate from staging evidence; never infer a staging result from a
  local test or mark acceptance complete without actually observing staging.

## Deployment record

| Item | Record |
|---|---|
| Feature commit/source revision | NOT RUN |
| Staging target alias | `staging.kurocyber.com` — NOT RUN |
| Staging protected/admin host aliases | `staging.kurocyber.com`; `admin-staging.kurocyber.com` — NOT RUN |
| Generated static-origin Worker/service name (alias) | `moqesh-staging-origin-<16 hex>` — NOT RUN |
| Existing external origin service/environment (normal deployments only) | NOT RUN |
| HCP Terraform workspace/state per account + installation ID; sole-writer review | NOT RUN |
| Cloudflare account/zone and proxied DNS preflight | NOT RUN |
| DNS records | CNAME `staging` → `kurocyber.com`, proxied; CNAME `admin-staging` → `kurocyber.com`, proxied — NOT RUN |
| Separate DNS-change approval (if records need creation) | NOT RUN |
| Existing route inventory and ownership review | NOT RUN |
| Route conflicts or ambiguity | NOT RUN |
| Operator Access policy confirmed | NOT RUN |

## Approval and route gates

| Gate | Expected | Result / approval reference |
|---|---|---|
| Bootstrap plan (`enable_public_route = false`) reviewed | Moqesh resources plus private static-origin Worker/assets; no public site route, DNS, production, or wildcard changes | NOT RUN |
| Bootstrap exact saved plan explicitly approved and applied | Approval is for the reviewed plan; no `-auto-approve` | NOT RUN |
| D1 migrations/runtime settings verified | Migrations `0001`, `0002`, `0003`; outputs `d1_migrations_verified=true` | NOT RUN |
| Worker secret binding names verified | `LURE_KEY_SECRET`, `ALERT_WEBHOOK_URL`; values not recorded | NOT RUN |
| Access admin route verified | Exact staging admin hostname and approved operator policy | NOT RUN |
| Static-origin hostname guard verified | Only `staging.kurocyber.com`; rejects `workers.dev` and unknown hosts | NOT RUN |
| Staging route plan reviewed | Only `staging.kurocyber.com/*` enables whole-host routing | NOT RUN |
| Staging route exact plan separately approved and applied | Production hostname remains untouched | NOT RUN |
| Workers.dev and preview URLs disabled | No alternate public entry point | NOT RUN |
| Scheduled trigger verified | `* * * * *` | NOT RUN |

## Static-origin and game acceptance

Record local-only evidence separately from staging results. The generated
static-origin Worker is private: verify it serves the game only through
Moqesh's `ORIGIN` service binding and rejects unknown hosts. A local game test
does not establish that the staging site works.

| Check | Expected result | Level | Result / evidence |
|---|---|---|---|
| Static-origin HTTP response | Successful game document/status recorded (expected HTTP 200); generated service name matches the approved account/installation identity | Local + staging | NOT RUN |
| Staging page load | Original runner renders at `staging.kurocyber.com` without external assets or third-party requests | Staging | NOT RUN |
| Game start and controls | Space, Arrow Up, and touch/tap start or control a run and trigger jumps | Local + staging | NOT RUN |
| Collision and game-over | Obstacle collision ends the run and displays game-over state | Local + staging | NOT RUN |
| Restart | Restart begins a fresh run and resets the current score | Local + staging | NOT RUN |
| Best score | Best score persists in browser `localStorage` after reload in the same browser | Local + staging | NOT RUN |
| Offline after initial load | After document/assets are loaded, gameplay continues without network access or external requests | Local + staging | NOT RUN |
| Origin hostname guard | Missing/unknown host returns a closed response; `workers.dev` and preview entry points cannot serve the origin | Local tests + staging configuration check | NOT RUN |

## Effective staging settings

Record the effective values used during the test. Defaults are not evidence
that a particular setting was deployed.

| Setting | Effective value |
|---|---|
| Lure paths (`/.env` and configured `BAIT_API_PATH`) | NOT RUN |
| Maze duration | NOT RUN |
| Block duration | NOT RUN |
| Per-source response budget | NOT RUN |
| Alert grouping interval | NOT RUN |
| Event/audit retention | NOT RUN |
| Allowlist | NOT RUN |
| Direct-lure alert binding | Expected: `false` in current Terraform; observed staging value: NOT RUN |

For elapsed-time tests, use explicit staging-only durations within supported
bounds and record them. The minimum maze duration is 1 minute and the minimum
block duration is 1 hour. A shortened staging run does not prove the
15-minute/24-hour production defaults.

## Request and control acceptance

| Check | Expected result | Level | Result / evidence |
|---|---|---|---|
| Ordinary uncontained request | Expected static-origin response and HTTP status; reaches origin through Moqesh; no event created | Staging | NOT RUN |
| Configured `/.env` | Decoy at the same URL with synthetic key and configured bait API URL; origin not called | Staging | NOT RUN |
| Invalid/missing bait API key | Unauthorized decoy; no confirmation or containment | Staging | NOT RUN |
| Valid synthetic key from a different source | Confirmation persists; key is not stored; eligible alert dispatches | Staging | NOT RUN |
| Allowlisted ordinary source | Bypasses maze/block and reaches origin | Staging | NOT RUN |
| Allowlisted direct lure | Event recorded; no direct-lure webhook alert with current `ALERT_DIRECT_LURE=false`; no containment | Staging | NOT RUN |
| Confirmed source during maze | Decoys on non-lure paths; origin not called; initial timer is not extended | Staging | NOT RUN |
| Response budget | Throttles with bounded response; does not shorten maze or start block early | Staging | NOT RUN |
| Maze expiry and block | Maze ends at configured time; block lasts configured duration | Staging, use recorded durations | NOT RUN |
| Block expiry | Normal handling resumes after configured block expiry | Staging, use recorded durations | NOT RUN |
| Manual unblock | Authorized operator clears source state; audit identifies actor/time/result | Staging | NOT RUN |
| Webhook grouping/retry | First eligible alert is immediate; grouping, retries and idempotency behave as designed | Staging | NOT RUN |
| Admin Access, anonymous | Anonymous request to `admin-staging.kurocyber.com` is denied before dashboard/API access | Staging | NOT RUN |
| Admin Access, unauthorized | Authenticated but unapproved identity is denied | Staging | NOT RUN |
| Admin Access, authorized | Approved operator identity can use the staging dashboard/API | Staging | NOT RUN |
| Public entry points and host guard | No public `workers.dev` or preview endpoint; origin host guard rejects unknown hosts | Staging configuration + local guard tests | NOT RUN |
| Production and wildcard unchanged | `kurocyber-website`, apex, `www`, and existing `*.kurocyber.com/*` route are unchanged | Staging comparison | NOT RUN |
| Event and audit privacy | No submitted key, auth header, cookies, body, query secrets, or full IP in this report | Local + staging inspection | NOT RUN |

## Degraded behavior and route safety

| Check | Safe verification method | Result |
|---|---|---|
| Durable Object/state unavailable | Automated local tests; only a controlled reversible staging fault if safe | NOT RUN |
| D1 read/write errors | Automated local tests; no deliberate disruption of shared staging data | NOT RUN |
| Webhook timeout/retry | Automated tests and a controlled staging test endpoint | NOT RUN |
| Access denial | Live staging request with no/unauthorized Access identity | NOT RUN |
| Route conflict handling | Read-only route inventory and Terraform plan-time preconditions; use a disposable zone for any live conflict test | NOT RUN |
| State/D1 recovery and operational errors | Confirm visible logs/recovery where safely observable | NOT RUN |

Do not create a conflicting customer route or intentionally disrupt shared
Cloudflare storage merely to force a failure. Mark any failure mode not safely
tested in staging as local-only or not verified.

## Latency, usage, and cost

| Measurement | Staging result |
|---|---|
| Origin baseline: workload, sample count, duration | NOT RUN |
| Routed workload: workload, sample count, duration | NOT RUN |
| Total requests and request rate for each workload | NOT RUN |
| Origin p50/p95 latency | NOT RUN |
| Routed p50/p95 latency and Worker-added delta | NOT RUN |
| Worker requests, CPU (including per-request or per-1,000-request measure), and usage source | NOT RUN |
| Durable Object operation counts/latency and usage source | NOT RUN |
| D1 read/write operation counts, storage, and retention assumptions | NOT RUN |
| Webhook volume and delivery cost assumptions | NOT RUN |
| Response-budget value and rationale | NOT RUN |
| Measured total/estimated staging cost and measurement period | NOT RUN |
| Customer-approved cost/usage budget and go/no-go | NOT RUN |

Include enough methodology to reproduce the comparison. Staging measurements
are not a production guarantee.

## Rollback and teardown

| Check | Expected result | Result / approval reference |
|---|---|---|
| Public staging route disabled via separate reviewed plan | Exact plan approved; existing `*.kurocyber.com/*` route remains unchanged and becomes applicable again | NOT RUN |
| Route fallback verified | Record the actual wildcard fallback; do not assume the private static origin is reached after the exact route is disabled | NOT RUN |
| D1 backup/retention decision | Record decision before destroy | NOT RUN |
| Staging destroy plan reviewed and separately approved | Removes only module-owned resources | NOT RUN |
| Teardown verified | DNS, external origin (if any), production Workers/routes, wildcard route, unrelated routes, and Access policies remain intact; private staging origin changes only as listed in the approved plan | NOT RUN |

## Findings and decision

- Unresolved failures/limitations: NOT RUN
- Follow-up work: NOT RUN
- Staging acceptance decision: NOT RUN
- Reviewer and date: NOT RUN
- Production readiness: NOT ESTABLISHED
