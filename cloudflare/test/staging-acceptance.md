# Anonymized Historical Cloudflare Staging Acceptance Record

> **Status: DEPLOYED; SMOKE TESTS PASSED; FULL ACCEPTANCE INCOMPLETE.**
> Staging was deployed on 2026-11-10 through separately approved DNS,
> bootstrap, recovery, and public-route changes. Observed results are recorded
> below. Timed lifecycle, cross-source, authenticated admin API, and cost
> acceptance remain incomplete; local tests are not staging evidence.
>
> This is a historical development record, not verification of your
> installation. Domains, resource names, source addresses, workspace identity,
> and saved-plan fingerprints have been removed or replaced with aliases.
> Reserved example domains are not live targets. Repeat acceptance with your
> own separately approved deployment and retain sensitive evidence privately.

## Safety and evidence handling

- Use staging-only Cloudflare resources, state/workspace, tfvars, credentials,
  and secrets.
- Store approval references and sanitized summaries here, not saved Terraform
  plans/state, API tokens, secret values, full source IPs, event payloads, or
  other customer-sensitive data.
- For each acceptance step, label evidence as **local**, **staging**, or
  **not verified**. A local test is not a staging result.
- Unperformed checks retain **NOT RUN**. Keep local game/test evidence separate
  from staging evidence; never infer a staging result from a local test or mark
  acceptance complete without actually observing staging.

## Deployment record

| Item | Record |
|---|---|
| Feature commit/source revision | Historical deployment fixes atop `5f4740e`; not a current deployment revision |
| Staging target alias | `staging.example.com` — illustrative alias for the historical target |
| Staging protected/admin host aliases | `staging.example.com`; `admin-staging.example.com` — illustrative aliases |
| Generated static-origin Worker/service name (alias) | `moqesh-staging-origin-<installation-derived-suffix>` |
| Existing external origin service/environment (normal deployments only) | Not used; private managed staging origin selected |
| HCP Terraform workspace/state per account + installation ID; sole-writer review | Private dedicated workspace; local execution, auto-apply off; initially no state; resulting remote state verified |
| Cloudflare account/zone and proxied DNS preflight | PASS: authenticated discovery and Terraform preconditions |
| DNS records | PASS: both approved proxied CNAMEs restored and read back; actual targets omitted |
| Separate DNS-change approval (if records need creation) | Explicit approval in deployment conversation before restoration |
| Existing route inventory and ownership review | Initially no zone Worker routes; finally only the two exact Moqesh staging routes |
| Route conflicts or ambiguity | None found by current discovery and plan preconditions |
| Operator Access policy confirmed | PASS: self-hosted admin Access application allows the approved email only; existing Cloudflare sign-in retained |

## Approval and route gates

| Gate | Expected | Result / approval reference |
|---|---|---|
| Bootstrap plan (`enable_public_route = false`) reviewed | Moqesh resources plus private static-origin Worker/assets; no public site route, DNS, production, or wildcard changes | PASS: 12 creates, no updates/deletions |
| Bootstrap exact saved plan explicitly approved and applied | Approval is for the reviewed plan; no `-auto-approve` | Exact saved plan approved; fingerprint retained privately; initial apply stopped at migration confirmation before admin route creation |
| Recovery exact saved plan explicitly approved and applied | Preserve created resources; resume migrations and then attach admin route | PASS: separately approved saved plan; fingerprint retained privately; skipped committed migration 0001 and verified all migrations |
| D1 migrations/runtime settings verified | Migrations `0001`, `0002`, `0003`; outputs `d1_migrations_verified=true` | PASS: live ledger/settings queries and remote state output |
| Required Worker secret binding names verified | `LURE_KEY_SECRET`; `ALERT_WEBHOOK_URL` is not required or verified when delivery is disabled (a previously provisioned secret is retained but unused); values not recorded | PASS: API binding-name read-back; `worker_secret_bindings_verified=true`; supplied token and lure-secret values absent from pulled remote state |
| Access admin route verified | Exact staging admin hostname and approved operator policy | PASS: anonymous document/API requests return 302 to the existing Access team |
| Static-origin hostname guard verified | Only `staging.example.com` in deployed traffic; rejects `workers.dev` and unknown hosts | Deployed source matches tested guarded implementation; direct URLs disabled; live unknown-host invocation not performed |
| Staging route plan reviewed | Only `staging.example.com/*` enables whole-host routing | PASS: public route create plus read-only ownership-helper replacement and D1 computed-metadata refresh |
| Staging route exact plan separately approved and applied | Production hostname remains untouched | PASS: separately approved saved plan; fingerprint retained privately |
| Workers.dev and preview URLs disabled | No alternate public entry point | PASS: both Workers' subdomain API settings report `enabled=false`, `previews_enabled=false` |
| Scheduled trigger verified | `* * * * *` | PASS: live schedule API read-back |

## Static-origin and game acceptance

Record local-only evidence separately from staging results. The generated
static-origin Worker is private: verify it serves the game only through
Moqesh's `ORIGIN` service binding and rejects unknown hosts. A local game test
does not establish that the staging site works.

| Check | Expected result | Level | Result / evidence |
|---|---|---|---|
| Static-origin HTTP response | Successful game document/status recorded (expected HTTP 200); generated service name matches the approved account/installation identity | Local + staging | PASS: live public document 200, correct game title; ORIGIN binding matches state |
| Staging page load | Original runner renders at `staging.example.com` without external assets or third-party requests | Staging | PASS: live browser render; all referenced document assets are same-origin and return 200 |
| Game start and controls | Space, Arrow Up, and touch/tap start or control a run and trigger jumps | Local + staging | PARTIAL: live keyboard/click controls and reduced-motion scoring verified; real touch-device input not verified |
| Collision and game-over | Obstacle collision ends the run and displays game-over state | Local + staging | PASS: live browser displayed collision/game-over |
| Restart | Restart begins a fresh run and resets the current score | Local + staging | PASS: live browser restart returned score to zero |
| Best score | Best score persists in browser `localStorage` after reload in the same browser | Local + staging | PASS: observed best score unchanged after reload |
| Offline after initial load | After document/assets are loaded, gameplay continues without network access or external requests | Local + staging | PASS: browser context offline; reduced-motion Space advanced score; connectivity restored |
| Origin hostname guard | Missing/unknown host returns a closed response; `workers.dev` and preview entry points cannot serve the origin | Local tests + staging configuration check | PASS for local guards and deployed-source/config checks; live unknown-host invocation not performed |

## Effective staging settings

Record the effective values used during the test. Defaults are not evidence
that a particular setting was deployed.

| Setting | Effective value |
|---|---|
| Lure paths (`/.env` and configured `BAIT_API_PATH`) | `/.env`, `/api/private/account`; both requested live |
| Maze duration | 15 minutes; live D1 settings |
| Block duration | 24 hours; live D1 settings |
| Per-source response budget | 100; live D1 settings and HTTP throttle test |
| Alert grouping interval | 5 minutes configured; webhook delivery disabled |
| Event/audit retention | 30 days; live D1 settings |
| Allowlist | Empty in deployment configuration |
| Direct-lure alert binding | `false` in deployed Worker configuration |
| Alert webhook enabled | `false`, verified through live Worker settings API |

For elapsed-time tests, use explicit staging-only durations within supported
bounds and record them. The minimum maze duration is 1 minute and the minimum
block duration is 1 hour. A shortened staging run does not prove the
15-minute/24-hour production defaults.

## Request and control acceptance

| Check | Expected result | Level | Result / evidence |
|---|---|---|---|
| Ordinary uncontained request | Expected static-origin response and HTTP status; reaches origin through Moqesh; no event created | Staging | PASS: game 200 before confirmation; initial event count zero |
| Configured `/.env` | Decoy at the same URL with synthetic key and configured bait API URL; origin not called | Staging | PASS: 200, synthetic-key shape and no-store verified without recording key |
| Invalid/missing bait API key | Unauthorized decoy; no confirmation or containment | Staging | PARTIAL: missing-key request returned 401; subsequent ordinary handling unaffected; separate malformed-key case not run live |
| Valid synthetic key from a different source | Confirmation persists, key is not stored, and containment starts; no webhook delivery in staging | Staging | PARTIAL: same-source reuse returned synthetic success and persisted one confirmation; subsequent root received maze decoy; outbox count zero. Cross-source reuse not run |
| Allowlisted ordinary source | Bypasses maze/block and reaches origin | Staging | NOT RUN |
| Allowlisted direct lure | Event recorded; no direct-lure webhook alert with current `ALERT_DIRECT_LURE=false`; no containment | Staging | NOT RUN |
| Allowlisted confirmed-key reuse with webhook disabled | Confirmation event is recorded; no webhook outbox entry or outbound request; allowlist still bypasses containment | Staging | NOT RUN |
| Confirmed source during maze | Decoys on non-lure paths; origin not called; initial timer is not extended | Staging | PARTIAL: root and unrelated path returned exact JSON maze decoy with 404, not runner HTML; timer non-extension not tested live |
| Response budget | Throttles with bounded response; does not shorten maze or start block early | Staging | PARTIAL: 100-request configured budget reached 429 with bounded JSON and Retry-After 30; timed transition invariants remain local-only |
| Maze expiry and block | Maze ends at configured time; block lasts configured duration | Staging, use recorded durations | NOT RUN |
| Block expiry | Normal handling resumes after configured block expiry | Staging, use recorded durations | NOT RUN |
| Manual unblock | Authorized operator clears source state; audit identifies actor/time/result | Staging | NOT RUN |
| Webhook grouping/retry | Existing alert-enabled behavior is covered by local tests; skipped in isolated staging while `alert_webhook_enabled=false` | Local tests; staging skipped | SKIPPED live: delivery disabled; live confirmation produced no outbox entry |
| Admin Access, anonymous | Anonymous request to `admin-staging.example.com` is denied before dashboard/API access | Staging | PASS: document and API returned Access redirects |
| Admin Access, unauthorized | Authenticated but unapproved identity is denied | Staging | NOT RUN |
| Admin Access, authorized | Approved operator identity can use the staging dashboard/API | Staging | Operator reported successful sign-in; not independently verified in the assistant browser, which remains unauthenticated; authenticated API checks NOT RUN |
| Public entry points and host guard | No public `workers.dev` or preview endpoint; origin host guard rejects unknown hosts | Staging configuration + local guard tests | PASS for settings/source and local guard tests; no live unknown-host invocation |
| Production and wildcard unchanged | `example-website`, apex, `www`, and unrelated routes unchanged; do not assume a wildcard exists | Staging comparison | PASS: apex/www custom domains still point to `example-website`; apex 200, www 301; only two new exact staging routes, no wildcard created |
| Event and audit privacy | No submitted key, auth header, cookies, body, query secrets, or full IP in this report | Local + staging inspection | Historical inspection found known secrets absent from remote state; this report was subsequently anonymized for publication; complete event/audit privacy review not performed |

## Degraded behavior and route safety

| Check | Safe verification method | Result |
|---|---|---|
| Durable Object/state unavailable | Automated local tests; only a controlled reversible staging fault if safe | NOT RUN |
| D1 read/write errors | Automated local tests; no deliberate disruption of shared staging data | NOT RUN |
| Webhook timeout/retry | Automated tests and a controlled staging test endpoint | NOT RUN |
| Access denial | Live staging request with no/unauthorized Access identity | Anonymous denial PASS; unapproved authenticated identity NOT RUN |
| Route conflict handling | Read-only route inventory and Terraform plan-time preconditions; use a disposable zone for any live conflict test | Live inventory/preconditions passed; deliberate conflict NOT RUN |
| State/D1 recovery and operational errors | Confirm visible logs/recovery where safely observable | PASS for observed failed bootstrap and approved recovery: error surfaced, admin route withheld, committed migration skipped on retry; backup restore NOT RUN |

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
| Webhook volume and delivery cost assumptions | Disabled; confirmation produced zero outbox entries; no external webhook configured |
| Response-budget value and rationale | 100 per source; live bounded 429 response verified; no billing guarantee |
| Measured total/estimated staging cost and measurement period | NOT RUN |
| Customer-approved cost/usage budget and go/no-go | NOT RUN |

Include enough methodology to reproduce the comparison. Staging measurements
are not a production guarantee.

## Rollback and teardown

| Check | Expected result | Result / approval reference |
|---|---|---|
| Public staging route disabled via separate reviewed plan | Exact plan approved; unrelated routes unchanged; do not create or assume a wildcard | NOT RUN |
| Route fallback verified | Rediscover routes, DNS, and custom domains; do not assume a wildcard exists or the private static origin is reached after route removal | NOT RUN |
| D1 backup/retention decision | Record decision before destroy | NOT RUN |
| Staging destroy plan reviewed and separately approved | Removes only module-owned resources | NOT RUN |
| Teardown verified | DNS, external origin (if any), production Workers/routes, wildcard route, unrelated routes, and Access policies remain intact; private staging origin changes only as listed in the approved plan | NOT RUN |

## Lure expansion update (2026-11-10)

- First apply (`lures.tfplan`) failed safely with Cloudflare 412 "Actor
  migration tag precondition failed": provider 5.28.1 does not keep the
  applied `AgentSession` Durable Object migration in state. The live Worker
  stayed unchanged. Fix: `agent_session_migration_applied = true` omits the
  migration on later uploads.
- Second apply (separately operator-approved saved plan, fingerprint omitted)
  succeeded. Worker updated, D1 migrations 0001–0004 recorded, all 11 earlier
  events kept, new route CHECK and indexes in place, lure secret re-uploaded.
- Live from host (IPv4, no key reuse): `/robots.txt` lists all 10 lure paths;
  `/.env.production`, `/.git/config`, `/.aws/credentials`, `/config.json`,
  `/backup.sql`, `/api/v1/keys` return 200 and leak the key; `/swagger.json`
  returns 200 with no key.
- `/wp-config.php.bak` (and `/wp-config.php`) returns Cloudflare's own 403
  "Sorry, you have been blocked" page before the Worker runs, so a zone-level
  security rule is catching it. The deploy token cannot read rulesets or
  security analytics, so the exact rule is unconfirmed.
- Browser containment: In the operator's browser (IPv6), `/config.json` was
  fetched and its key reused at `/api/private/account` (200). A normal page
  reload of `/` then returned 404 `{"error":"Not found"}`. The earlier "refresh
  not blocked" report happened because the demo script (host IPv4) and browser
  (IPv6) are different sources; containment is per IP.
- Follow-up: on updates, the new Worker goes live about 2 seconds before D1
  migrations run, so events on new routes can fail to save in that window.

## Findings and decision

- Unresolved failures/limitations: Initial migration-helper result-count
  mismatch was fixed and recovery verified. Full acceptance remains incomplete.
  The test runner deliberately triggered its own containment and budget limit;
  clear that source through the authenticated dashboard before repeating
  ordinary browsing checks from the same connection.
- Follow-up work: Independently verify authenticated admin APIs, unauthorized
  identity denial, manual unblock/audit, cross-source reuse, allowlists,
  maze/block expiry, real touch input, latency/usage/cost budget, and rollback.
  Review Worker logs/traces configuration and provider cron teardown caveat.
  Check token expiry and scope before each deployment; restrict credentials
  to the selected account and zone.
- Operations: dedicated private HCP workspace, local execution, Cloudflare
  provider 5.28.1, Terraform CLI 1.10.5. Preserve the installation ID in the
  ignored deployment tfvars and use its workspace as the sole writer. Local runs still require
  protected credential files; workspace variables are not injected.
- Staging acceptance decision: Deployment and smoke testing passed; available
  for operator testing, not full acceptance or production-apex cutover.
- Reviewer and date: Copilot-assisted deployment and observed tests, 2026-11-10;
  operator reported admin sign-in.
- Production readiness: NOT ESTABLISHED

## Rabbit-hole chain (2026-11-10)

- Historical implementation commits `6846126`..`b2e5913`: 10-hop chain, chain depth in the per-IP Durable Object, migration 0005, maze-mode hop serving, the 8-stage demo, docs, and a review fix so sources contained before the deploy can enter the chain from hop 1.
- Local validation: 110 Worker tests, 39 deployment tests, 15 staging-origin tests, 20 demo tests; typecheck, binding check and build clean.
- Exact saved plan approved by the operator; fingerprint omitted. Plan: 3 to add, 2 to change, 3 to destroy. Worker updated in place with no Durable Object migration; no route, DNS, Access, zone or production changes.
- Apply: "Verified D1 migrations 0001 through 0005"; apply complete. The D1 ledger lists 0001–0005, the `events` table accepts `rabbit_hole_hop`, and the 22 existing events were preserved.
- Historical live walk from a dedicated test source (address omitted), script-driven:
  - `/` returned 200 with the runner.
  - `/config.json` returned 200 with the key, and reusing it at `/api/private/account` returned 200 hop 1 with a lead to `/api/private/billing`.
  - `/` returned 404 `{"error":"Not found"}` while in the maze.
  - Hops 2–10 (`/api/private/billing` … `/api/internal/vault/root`) each returned 200 fake data with the next lead; hop 10 had no lead.
  - `/` returned 403 immediately after hop 10.
- D1 events for that source: `unconfirmed_lure_view` (`config-json`), `confirmed_reuse` (`bait-api`), 9 `rabbit_hole_hop` (`hop-2` … `hop-10`), and `block`.
- Pending at the time of recording: the operator confirms the hop events in Detections and unblocks the test source in Containment.
