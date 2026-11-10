# Cloudflare Worker and private dashboard

## Traffic model

The public Worker route is **whole-host**, not lure-path-only: after the
staging or production route is explicitly enabled, Cloudflare invokes the
Worker for every request to the selected protected hostname. For an
allowlisted or otherwise uncontained source, an ordinary non-lure request is
forwarded to the selected `ORIGIN` service (or, with `origin_type = "dns"`,
to the server behind the protected hostname's DNS record); it is not sent into the decoy maze
and is not written to event history. This pass-through still incurs Worker
execution; non-allowlisted sources with a usable IP also incur a per-source
state check. The disclosure lures (`/.env`, `/.env.production`, `/.git/config`, `/.aws/credentials`, `/config.json`, `/wp-config.php.bak`, `/backup.sql`, `/api/v1/keys`, and `/swagger.json`) and `BAIT_API_PATH` are always
intercepted by the Worker. Disclosure lures leak the same synthetic key (or, for
`/swagger.json`, advertise the bait API) and are logged as unconfirmed views;
only Bearer reuse of that key at `BAIT_API_PATH` confirms a source.
`/robots.txt` is answered by the Worker with `Disallow` hints for every lure and
is never logged. Lures are always handled by the Worker: enabled lures return decoys, while disabled lures return 404
rather than reaching `ORIGIN`. A confirmed source receives decoy/maze or block
responses across the whole hostname and is not forwarded to `ORIGIN`.

### Rabbit-hole chain

The confirmed `BAIT_API_PATH` response is hop 1 of a 10-hop chain of fake
API data. Each response for hops 1–9 carries a `next` lead: the absolute URL of the next hop and
a per-hop bearer token. The hop paths are `/api/private/billing`,
`/api/private/team`, `/api/private/admin/users`, `/api/private/admin/keys`,
`/api/internal/services`, `/api/internal/deploy/secrets`,
`/api/internal/db/credentials`, `/api/internal/backups`, and
`/api/internal/vault/root` (hop 10, which has no lead). Hop tokens and fake
values are HMAC-derived from `LURE_KEY_SECRET`, so they are deterministic and
contain no real credentials; hostnames use `*.example.invalid`.

Chain hops are served only to a source that is already in maze mode, and only
with that hop's token and in order: an earlier hop may be revisited, but a
skipped hop or a wrong token gets the maze 404 and counts against the response
budget. Every other request from that source, including the real site, still
gets the maze 404. Each accepted hop from 2 to 10 is logged as a
`rabbit_hole_hop` event with route `hop-2` … `hop-10`. Hop 10 ends the maze
immediately and starts the configured block (default 24 hours). If the source
never reaches hop 10, the normal maze duration still applies. Uncontained
sources requesting hop paths are forwarded to `ORIGIN` like any other path.

If the public route is disabled, requests to the protected hostname do not
invoke this Worker. Route only a dedicated staging hostname during acceptance;
the production hostname remains untouched until staging is accepted and a
separate production plan is reviewed and approved.

The admin hostname is separate and Access-protected, but its route reaches the
same Worker script and dashboard assets. Terraform does not deploy a second
admin Worker.

For the isolated Kurocyber staging runner, `ORIGIN` is a separate
Terraform-managed static-origin Worker rather than the production site or an
external origin. It serves only `staging.kurocyber.com`, and its hostname
guard returns 404 for `workers.dev` and unknown hosts. Normal uncontained
requests reach this origin through Moqesh's `ORIGIN` service binding; lure and
contained-source responses are handled by Moqesh and do not reach the origin.

The Worker serves the protected dashboard and `/api/admin/*` only when the
request hostname exactly matches `ADMIN_HOSTNAME`. It verifies the
`Cf-Access-Jwt-Assertion` signature against the configured
`ACCESS_TEAM_DOMAIN` certificates and requires the `ACCESS_AUD` audience.
State-changing requests also require a same-origin HTTPS `Origin` header.
Requests for admin APIs on other hostnames—including a `workers.dev` hostname—
return 404 without reaching the origin.

Runtime settings and the operator allowlist are stored in D1. The admin and
containment-index migrations (`migrations/0002_admin.sql` and
`migrations/0003_containment_sources.sql`) and the expanded lure-route migration
(`migrations/0004_more_lure_routes.sql`) and the rabbit-hole hop event migration
(`migrations/0005_rabbit_hole_events.sql`) must be applied before attaching the
Worker route. The AgentSession Durable Object migration (tag `v1`) is sent only
while `agent_session_migration_applied = false`; set it to `true` after the
first successful apply, because Cloudflare rejects a resent `v1` migration with
HTTP 412 ("Actor migration tag precondition failed") on later Worker updates. Retention can be reduced from the 30-day maximum; event source
IPs, event history, audit records, and webhook payloads expire within that
window. A separate minimal containment index keeps a source discoverable until
its Durable Object's recorded block expiry, even if its events expire first.
This operational index is cleaned up by scheduled work after expiry and is
bounded by the maximum supported containment lifetime (7 days, 2 hours).
Manual unblocks call the source's Durable Object and keep an audit record with
the verified operator identity, request time, and result.

Terraform-managed hostnames, Access configuration, routes, and webhook
destination cannot be changed through the dashboard. The dashboard displays
only the webhook hostname, never its URL path or query string.

Runtime bounds are: maze 1–120 minutes, block 1–168 hours, response budget
1–10,000, alert grouping 1–60 minutes, and retention 1–30 days. Defaults are
15 minutes, 24 hours, 100 responses, 5 minutes, and 30 days respectively.

The Worker expects Terraform to configure `ADMIN_HOSTNAME`, `ADMIN_ROUTE`,
`PUBLIC_SITE_HOSTNAME`, `PUBLIC_ROUTE`, `ACCESS_TEAM_DOMAIN`, and `ACCESS_AUD`.
Keep `LURE_KEY_SECRET` and, when enabled, `ALERT_WEBHOOK_URL` in Cloudflare's
secret store; the dashboard never returns either value. `ALERT_WEBHOOK_URL` is
required only when `alert_webhook_enabled = true`.
Terraform currently sets `ALERT_DIRECT_LURE = false`, so an allowlisted
direct-lure request is recorded but does not send its own webhook alert or
start containment. Confirmed-key webhook alerts are controlled by
`alert_webhook_enabled`, which defaults to true. The isolated Kurocyber staging
example sets it to false: lure and containment events remain recorded in D1
and visible in the dashboard, but no webhook outbox jobs are created or
delivered. This is not a secret-revocation operation: if a webhook secret was
previously provisioned, it remains stored but is unused while delivery is
disabled. Any unexpired outbox entries already present are retained and may be
retried if delivery is enabled again.

## Guided attack demonstration

From the repository root, run the dependency-free Python 3.11+ walkthrough:

```sh
python3 cloudflare/scripts/demo_attack.py
# or, for your own deployment:
python3 cloudflare/scripts/demo_attack.py \
  --base-url https://app.example.com --admin-url https://admin.example.com
```

Keep the admin dashboard (by default `https://admin-staging.kurocyber.com`) open
and sign in before starting. The script targets only the one `--base-url` origin
(default `https://staging.kurocyber.com`), accepts only bare `https://` origins,
and requests only the fixed demo paths. Point it at a staging hostname, not a
production site you cannot afford to have your IP blocked on. Each of eight
stages shows the request URL, headers,
empty request body, expected result, HTTP status, selected response headers,
and response body. Long responses are explicitly truncated. Type uppercase
`NEXT` to authorize each individual request; `QUIT`, Ctrl-C, or EOF stops.
Piped/unattended input is rejected.

Containment is keyed on the **public source IP**, not the browser. A preflight
step shows the IP Cloudflare sees for the script. Open
`https://staging.kurocyber.com/cdn-cgi/trace` in the browser you plan to refresh
and compare the `ip=` line. If the script runs on a different machine (for
example a Linux VS Code remote host) or uses IPv4 while the browser uses IPv6,
the browser will still see the game after Stage 5. In that case, run the
script on the browser's machine, or demonstrate the browser refresh from a
browser on the script's host.

The stages are normal browsing, missing-key rejection, synthetic credential
discovery, synthetic-key reuse (hop 1), maze diversion, the rabbit hole (stage
6 follows hops 2–10, each previewed and needing its own `NEXT`, 16 requests in
total), the block (stage 7 expects HTTP 403), and recovery after manual
unblock. The script refuses any lead that is not the next fixed staging hop. The synthetic key is deliberately visible in the lure response and
reuse request; do not substitute real credentials. No deployment tokens or
extra packages are required. The script does not follow redirects, retry
requests, exhaust rate limits, or make authenticated admin requests.

This is a **live staging exercise**, not a dry run: events persist, and reuse
contains the source public IP. Everyone sharing that IP may be affected;
incognito does not isolate a source. Before starting, unblock the demo source
and ensure it is not allowlisted. Stay on the same connection throughout.
In the final stage, use **Containment > Unblock** in the dashboard before typing
`NEXT`; the script then verifies that the runner returns. Cancellation after
confirmation does not clear containment. Refresh Detections/Containment at
the indicated checkpoints and inspect the unblock audit entry yourself.
Webhook delivery remains disabled for this deployment. The script verifies
HTTP behavior, not dashboard persistence, timed expiry, or cross-source reuse.

Offline script regression tests (no staging requests), from the repository root:

```sh
python3 -m unittest discover -s cloudflare/test -p 'demo_attack_test.py' -v
```

## Local Worker validation

From this directory:

```sh
npm ci
npm test -- --run
npm run test:deployment
npm run check:bindings
npm run typecheck
npm run build
```

`npm run build` builds the Vite dashboard to `dashboard/dist` without source
maps, then runs Wrangler's local dry-run bundle check. It does not deploy or
provision Cloudflare resources. Production routing, including disabling the
alternate `workers.dev` route, is managed in Terraform.

## Customer-owned Terraform deployment

The customer owns the Cloudflare account, zone, Terraform state, API token,
Worker secrets, and approval to attach the public route. Terraform manages only
the Moqesh Worker, its assets and bindings, its scheduled trigger and Durable
Object migration, the Moqesh D1 database and migrations, the dashboard Access
application/policy, the Worker `workers.dev` setting, and the two explicitly
named Worker routes.
It does **not** create or edit DNS records, change unrelated routes, or create,
replace, or delete an external origin.

Choose how ordinary traffic reaches the real site with `origin_type`:

- `origin_type = "dns"` (recommended for most sites): leave
  `origin_service_name = ""`. No `ORIGIN` binding is created; the Worker
  forwards ordinary requests with `fetch(request)`, which Cloudflare sends to
  the server behind the protected hostname's proxied DNS record without
  re-invoking the Worker. It forwards only requests whose hostname equals
  `protected_hostname` and returns `404` otherwise, so it is not an open
  proxy. The admin hostname never forwards.
- `origin_type = "worker"` (the default): `origin_service_name` must refer to an
  existing Worker service that serves the site; it is bound as `ORIGIN`.

`create_staging_origin = true` cannot be combined with `origin_type = "dns"`.
For a step-by-step installation, see [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).
The explicitly opted-in Kurocyber staging mode instead creates a private,
Terraform-managed static origin and binds the Moqesh Worker to it.

### Isolated Kurocyber staging runner

The staging topology is:

| Host/resource | Role |
|---|---|
| `staging.kurocyber.com` | Public, whole-host Moqesh staging route; ordinary uncontained traffic is forwarded to the static game origin. |
| `admin-staging.kurocyber.com` | Separate admin hostname protected by Cloudflare Access; it reaches the Moqesh dashboard/API, not the game origin. |
| Static-origin Worker | Serves the original static runner game only for `staging.kurocyber.com`, through the Moqesh `ORIGIN` service binding. Its hostname guard rejects `workers.dev` and unknown hosts. |
| `kurocyber-website`, `kurocyber.com`, `www.kurocyber.com` | Production Worker/custom domains stay unchanged. The existing `*.kurocyber.com/*` route also stays unchanged. |

Use `terraform/examples/kurocyber-staging.tfvars.example` as the starting
point, not `basic.tfvars.example`. Its isolated names are
`moqesh-kurocyber-staging` for the Moqesh Worker and
`moqesh-kurocyber-staging-events` for D1. It sets
`create_staging_origin = true` and leaves `origin_service_name` empty; Terraform
derives the static-origin Worker name as
`moqesh-staging-origin-<16 lowercase hex characters>`. The suffix is the first
16 hex characters of SHA-256 over
`lower(account_id) + ":" + installation_id`, so the name is 38 characters
long. `installation_id` must be stable, unique, non-secret, and 8–128
characters. Do not reuse the production Worker, D1 database, Durable Object
namespace, secrets, or state/workspace for staging.

Terraform does not manage DNS. Before **any** plan/apply, verify the current
account has proxied records for both exact hostnames; do not assume records
exist based on an earlier inspection. Terraform's data-source preflight
requires those records and stops if they are absent or unproxied. If records
must be created, propose the exact records below and obtain explicit approval
for the DNS change separately from approval of each Terraform plan:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `staging` (`staging.kurocyber.com`) | `kurocyber.com` | Proxied (orange cloud) |
| CNAME | `admin-staging` (`admin-staging.kurocyber.com`) | `kurocyber.com` | Proxied (orange cloud) |

Do not alter, replace, or delete unrelated DNS records or routes, including
any wildcard records/routes that exist. Do not create a wildcard route as a
deployment prerequisite. While the exact staging route is enabled, it takes
precedence for `staging.kurocyber.com`. If that route is later disabled or
removed, an existing matching wildcard route may become applicable; otherwise
the current DNS/custom-domain/origin configuration determines the fallback.
The latest pre-deployment discovery found no zone Worker routes. Neither case
restores the private static origin. Verify and document the actual fallback
before any route rollback.

Use one access-controlled HCP Terraform workspace and remote state per
Cloudflare account plus installation ID. That workspace/state is the **sole
writer** for the derived static-origin Worker name; do not manage the same
account/installation identity from another workspace or state. The ownership
guard is a read-only Workers Scripts API lookup, not a cross-state lock. It
requires `CLOUDFLARE_API_TOKEN` with Workers Scripts Read in addition to the
existing apply credentials. It fails closed on API errors, invalid or
ambiguous responses, or an origin not owned by this installation. Read-only
DNS, route, and Access discovery and Terraform planning are allowed. Do not
make Cloudflare writes or other resource-changing calls, run the ownership
guard, or apply resources until the applicable exact plan and any separate DNS
change have received explicit approval.

The bootstrap plan uses `enable_public_route = false`: it includes the Moqesh
staging resources and private static origin, but no public site route, DNS,
production resources, or wildcard changes. After explicit approval of that
exact saved plan and apply, verify the Access-protected admin route, D1
migrations, secret binding names, disabled `workers.dev`/preview URLs, and
static-origin hostname guard. Only then create a separate exact saved plan
with `enable_public_route = true` for `staging.kurocyber.com/*`; obtain a new
explicit approval before applying it. Every plan needs its own approval.
Production is out of scope and requires separate discovery, state, plan, and
consent.

### Prerequisites and local checks

- An active Cloudflare account and zone, with both `protected_hostname` and
  `admin_hostname` already present in DNS and proxied through Cloudflare.
  Terraform reads and verifies these records but never manages them.
- When `create_staging_origin = false` (the normal mode), either
  `origin_type = "dns"` with the protected hostname's proxied DNS record
  pointing at the real site, or `origin_type = "worker"` with an existing
  origin Worker service and environment that can serve the protected
  hostname's ordinary traffic. For the isolated Kurocyber staging runner, use
  `create_staging_origin = true` and the dedicated tfvars example above
  instead; Terraform creates the private static origin.
- A configured Cloudflare Access team domain and the exact operator email
  addresses to allow on the admin hostname.
- A supported local Node.js/npm toolchain, the official Terraform CLI, and
  access to an HCP Terraform organization/workspace for remote state.
- For a normal production deployment, a separate staging hostname/zone with an
  equivalent origin and Access policy must pass acceptance before planning a
  production route. The Kurocyber staging runner described above is its own
  isolated staging deployment and does not authorize or include production.

Build the assets and Worker bundle before running Terraform:

```sh
npm ci
npm test -- --run
npm run test:deployment
npm run check:bindings
npm run typecheck
npm run build
```

The binding check compares the Wrangler local configuration against Terraform,
including the `ORIGIN`, `AGENT_SESSIONS`, `EVENTS_DB`, assets, runtime variables,
`BAIT_API_PATH`, and secret binding names. Both the application Worker and the
private static-origin Worker must declare their own `ASSETS` binding with
type `assets`; uploading asset files alone does not provide `env.ASSETS`.
The Wrangler D1 ID is intentionally a
local-test placeholder; Terraform and the migration runner use the real
`cloudflare_d1_database.events.id` output and reject that placeholder.

For local Worker tests, create an ignored `cloudflare/.dev.vars` file containing
a local-only `LURE_KEY_SECRET` with at least 32 bytes. Never put production
secrets in Wrangler `vars`, `.tfvars`, source control, or test fixtures.

### State, credentials, and secrets

Use the declared HCP Terraform `cloud` integration with a **remote,
access-controlled workspace**. Select the existing organization and workspace
through environment variables, and supply the user token securely through
`TF_TOKEN_app_terraform_io` (never a command-line argument):

```sh
cd cloudflare/terraform
export TF_CLOUD_ORGANIZATION=YOUR_TERRAFORM_CLOUD_ORG
export TF_WORKSPACE=YOUR_ACCOUNT_INSTALLATION_WORKSPACE
terraform init -input=false
```

Use the organization name, not its `org-...` identifier. An empty `cloud {}`
block reads these environment variables; `backend "cloud"` is not a supported
Terraform backend and `-backend-config` does not configure this integration.
Verify that the workspace exists and has no unexpected state before
initialization; stop rather than migrating unrelated state.

Configure that workspace for **local execution** so Terraform can read the
locally built Worker bundle/assets and run the checked-in D1/secret provisioning
scripts on the approved machine or CI runner. Remote HCP Terraform state remains
the state/locking source of truth. Do not use a local state file for a customer
deployment, check in state/plan files, or share state snapshots. Review HCP
Terraform access, encryption, retention, and audit settings before use.
For Kurocyber staging, use one access-controlled HCP Terraform workspace and
state per `(lower(account_id), installation_id)` identity. That workspace/state
is the sole writer for the derived static-origin Worker name; do not manage
that same identity from another workspace or state. The ownership guard is
not a cross-state lock. Choose the workspace name to uniquely identify that
account and installation; do not reuse the placeholder above.
The module pins the [Cloudflare Terraform provider](https://registry.terraform.io/providers/cloudflare/cloudflare/5.28.1)
to v5.28.1 and records its checksums in `terraform/.terraform.lock.hcl`.

Create a narrowly scoped Cloudflare API token for only the target account and
zone. Grant the Cloudflare permissions required by the pinned provider resources
and scripts: Workers Scripts read/write, Workers Routes read/write, D1
read/write, Access Apps and Policies read/write, Zone read, and DNS read. DNS
write is not needed. Do not use a Global API Key. Supply the token only through
`CLOUDFLARE_API_TOKEN` in the protected local/CI environment; Terraform reads it
through the provider, and its local provisioning steps inherit it. Do not put
the token in Terraform variables, command-line arguments, logs, or tfvars.
For Kurocyber staging, the origin-ownership preflight itself only performs a
read-only Workers Scripts API lookup and requires Workers Scripts Read. The
surrounding Terraform apply still requires the existing narrowly scoped apply
credentials. The guard fails closed on API errors or ambiguous ownership
evidence; do not invoke it or make other real Cloudflare calls before the
explicit deployment step.

Copy `terraform/examples/basic.tfvars.example` to an ignored
`terraform/terraform.tfvars` and replace every `REPLACE_...` placeholder with
the customer's real non-secret configuration. The example values are
intentionally invalid and are not deployable. Do not place secret values in
that file.

Set these protected environment variables only in the environment that will
run the approved `terraform apply`:

- `MOQESH_LURE_KEY_SECRET`: a unique, random, per-installation value of at
  least 32 bytes (for example, generate one with a customer-approved secret
  manager).
- `MOQESH_ALERT_WEBHOOK_URL`: the HTTPS webhook destination; required only
  when `alert_webhook_enabled = true`.
- `CLOUDFLARE_API_TOKEN`: the narrowly scoped API token described above.

The Terraform apply invokes a checked-in helper that uploads and verifies the
Worker secret bindings required by the selected configuration using
Cloudflare's [bulk Worker secrets API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/bulk_update/).
With alerts disabled, only `LURE_KEY_SECRET` is uploaded and verified; with
alerts enabled, both `LURE_KEY_SECRET` and `ALERT_WEBHOOK_URL` are required.
D1 migrations use the official
[D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
with a batch that records migration completion.
The secret values are read from the process environment, never passed as
Terraform inputs, printed, or written to state. Terraform state and plans do
contain account/configuration and resource metadata, plus the binding-name
references and non-secret `secret_rotation_revision`, so protect them as
sensitive deployment data. Cloudflare stores the secret values. Worker updates preserve
`secret_text` bindings. Increment `secret_rotation_revision` in tfvars whenever
either secret changes so Terraform reapplies and verifies the upload. Protect
the apply runner and environment just as carefully as other privileged
deployment credentials.

### Plan, review, approval, and staged route

Run Terraform from `cloudflare/terraform`. Review all changes in the generated
plan; Cloudflare MCP is for **read-only discovery and post-change verification**
only. MCP is not Terraform's state, refresh, dependency, or plan engine.

Use three distinct route stages. Staging and production must have separate
hostnames and customer-owned Terraform state/workspaces, tfvars, credentials,
and secrets.

1. **Staging bootstrap:** Set `enable_public_route = false` (the default).
   For Kurocyber, first verify both staging DNS records are present and
   proxied; any DNS creation requires separate explicit approval before
   planning. With `create_staging_origin = true`, the complete saved plan
   includes the Moqesh resources and private static-origin Worker/assets,
   along with D1, Durable Object namespace/migration, scheduled trigger,
   secrets, Access application/policy, and the Access-protected admin route.
   It contains no DNS, public staging site route, production resource, or
   wildcard change. Review and obtain explicit approval of that exact plan
   before applying. The protected staging site hostname does not invoke
   Moqesh during bootstrap. The migration provisioner applies all checked-in
   SQL migrations to Terraform's D1 database, records successful migrations,
   verifies `0001`, `0002`, and `0003`, and initializes runtime defaults
   without overwriting dashboard settings later. Migration failure halts
   before either route is attached.
2. **Staging acceptance route:** After bootstrap, verify the admin Access
   route/policy, D1 migrations, secret binding names, disabled `workers.dev`
   and preview URLs, and static-origin hostname guard. Then repeat read-only
   route discovery, set `enable_public_route = true` only for the dedicated
   staging hostname, create and show a new complete saved plan, and get
   separate explicit approval before applying it. This whole-host route is
   necessary to test the live Worker request path; ordinary uncontained
   requests still pass through `ORIGIN` to the static origin without event
   logging. Production and the wildcard route remain untouched.
3. **Production route:** Only after staging acceptance is documented and
   reviewed, perform fresh production discovery, prepare production-specific
   state/configuration, then create and show a separate production plan with
   `enable_public_route = true`. Explain the whole-host impact and wait for
   explicit approval of that exact plan before applying it. Staging approval
   does not authorize production.

For each route stage, use this saved-plan review flow (save plan files only in
the ignored Terraform directory):

```sh
terraform plan -var-file=terraform.tfvars -out=staging.tfplan
terraform show -no-color staging.tfplan
```

Pause and obtain explicit human approval of the complete plan before applying
the saved plan:

```sh
terraform apply staging.tfplan
```

Do not use `-auto-approve`. Terraform attaches the whole-host route as
`protected-hostname/*` only after the Worker, bindings, schema, secret names,
Access application/policy, and admin route are ready. Access protects the
admin hostname only, never the public hostname. `workers.dev` and Worker
preview URLs are explicitly disabled. After each bootstrap apply, confirm
`terraform output d1_migrations_verified` and
`terraform output worker_secret_bindings_verified` are both `true` before
planning that stage's public route. Keep the staging route attached only for
the approved acceptance window; route removal requires its own reviewed,
approved plan.

The staged migrations run through the Terraform apply's local D1 API helper,
with the real database ID supplied by Terraform. Do not run Wrangler's local
placeholder database against production or run its local migration workflow
against the customer database.
The helper checks success for every returned SQL statement and verifies the
migration ledger. If an apply stops after a migration was committed, review
a fresh recovery plan: the ledger skips already applied migration files.

### Updates, rollback, and uninstall

- Build and review the exact Worker/assets change before planning. Add future
  D1 schema changes as new, ordered migration files; do not edit an already
  applied migration. The Terraform migration runner is idempotent and verifies
  the migration ledger before route creation.
- Runtime values are initialized in D1 on the first apply. The dashboard can
  subsequently change runtime settings; Terraform does not overwrite existing
  dashboard settings on routine applies.
- For rollback, first plan and approve removal of the public route by setting
  `enable_public_route = false`. Rediscover matching routes, DNS, and custom
  domains and verify the actual fallback; do not assume a wildcard route
  exists or recreate one. Disabling the exact route does not restore the
  private static origin. Then plan and approve a Worker code/assets rollback.
  Preserve D1 and its data unless a separately reviewed retention/backup
  decision authorizes removal.
- For uninstall, inspect a saved Terraform plan and confirm it removes only
  this deployment's two Worker routes, Access application, Worker/subdomain,
  D1 database, and associated managed resources. Back up any required D1 data.
  Do not remove customer DNS records or an external existing origin service;
  Terraform does not own them. For Kurocyber staging, the private static origin
  is Terraform-managed and may be removed only as part of the reviewed plan for
  this installation. Obtain explicit approval before applying any destroy
  plan.

Formatting and credential-free provider validation:

```sh
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

These commands validate configuration only; they do not plan against, apply to,
or provision a customer Cloudflare account.
