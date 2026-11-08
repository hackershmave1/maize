# Cloudflare Worker and private dashboard

The Worker serves the protected dashboard and `/api/admin/*` only when the
request hostname exactly matches `ADMIN_HOSTNAME`. It verifies the
`Cf-Access-Jwt-Assertion` signature against the configured
`ACCESS_TEAM_DOMAIN` certificates and requires the `ACCESS_AUD` audience.
State-changing requests also require a same-origin HTTPS `Origin` header.
Requests for admin APIs on other hostnames—including a `workers.dev` hostname—
return 404 without reaching the origin.

Runtime settings and the operator allowlist are stored in D1. The admin and
containment-index migrations (`migrations/0002_admin.sql` and
`migrations/0003_containment_sources.sql`) must be applied before attaching the
Worker route. Retention can be reduced from the 30-day maximum; event source
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
Keep `LURE_KEY_SECRET` and `ALERT_WEBHOOK_URL` in Cloudflare's secret store;
the dashboard never returns either value.

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
replace, or delete the existing `ORIGIN` Worker service. `origin_service_name`
must refer to that existing service.

### Prerequisites and local checks

- An active Cloudflare account and zone, with both `protected_hostname` and
  `admin_hostname` already present in DNS and proxied through Cloudflare.
  Terraform reads and verifies these records but never manages them.
- An existing origin Worker service and environment that can serve the
  protected hostname's ordinary traffic.
- A configured Cloudflare Access team domain and the exact operator email
  addresses to allow on the admin hostname.
- A supported local Node.js/npm toolchain, the official Terraform CLI, and
  access to an HCP Terraform organization/workspace for remote state.
- A staging hostname/zone with an equivalent origin and Access policy for
  acceptance tests before enabling the production route.

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
`BAIT_API_PATH`, and secret binding names. The Wrangler D1 ID is intentionally a
local-test placeholder; Terraform and the migration runner use the real
`cloudflare_d1_database.events.id` output and reject that placeholder.

For local Worker tests, create an ignored `cloudflare/.dev.vars` file containing
a local-only `LURE_KEY_SECRET` with at least 32 bytes. Never put production
secrets in Wrangler `vars`, `.tfvars`, source control, or test fixtures.

### State, credentials, and secrets

Use the declared HCP Terraform Cloud backend with a **remote, access-controlled
workspace**. Initialize it with the organization's workspace:

```sh
cd cloudflare/terraform
terraform init \
  -backend-config="organization=YOUR_TERRAFORM_CLOUD_ORG" \
  -backend-config="workspaces.name=moqesh-cloudflare-staging"
```

Configure that workspace for **local execution** so Terraform can read the
locally built Worker bundle/assets and run the checked-in D1/secret provisioning
scripts on the approved machine or CI runner. Remote HCP Terraform state remains
the state/locking source of truth. Do not use a local state file for a customer
deployment, check in state/plan files, or share state snapshots. Review HCP
Terraform access, encryption, retention, and audit settings before use.
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
- `MOQESH_ALERT_WEBHOOK_URL`: the HTTPS webhook destination.
- `CLOUDFLARE_API_TOKEN`: the narrowly scoped API token described above.

The Terraform apply invokes a checked-in helper that uploads the two Worker
secrets using Cloudflare's [bulk Worker secrets API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/bulk_update/)
and verifies their binding names. D1 migrations use the official
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

First apply with `enable_public_route = false` (the default). This stage provisions the Worker, assets, D1, Durable Object
namespace/migration, scheduled trigger, Access application/policy, secret
bindings, and migrations, and only then adds the Access-protected admin route. The migration provisioner applies every checked-in
SQL migration to the Terraform-created D1 database, records successful
migrations in D1, verifies migrations `0001`, `0002`, and `0003`, and initializes
runtime defaults without overwriting dashboard settings on later applies.
Migration failure stops the apply before any route is attached.

Use this two-step plan review flow (save plan files only in the ignored
Terraform directory):

```sh
terraform plan -var-file=terraform.tfvars -out=staging.tfplan
terraform show -no-color staging.tfplan
```

Pause and obtain explicit human approval of the complete plan before applying
the saved plan:

```sh
terraform apply staging.tfplan
```

Do not use `-auto-approve`. Run the same staged workflow in a staging zone and
enable its public route only after verifying ordinary origin pass-through,
both lure paths, dashboard Access, secret/D1 readiness, and teardown ownership.
For production, first keep the public route disabled, inspect MCP discovery for
route conflicts again, then set `enable_public_route = true`, create and show a
new saved plan, and wait for a separate explicit approval before applying it.
Terraform attaches the whole-host route as `protected-hostname/*` only after
the Worker, bindings, schema, secret names, Access application/policy, and admin
route are ready. Access protects the admin hostname only, never the public
hostname. `workers.dev` and Worker preview URLs are explicitly disabled.
After the stage-one apply, confirm `terraform output d1_migrations_verified`
and `terraform output worker_secret_bindings_verified` are both `true` before
planning the staging or production public route.

The staged migrations run through the Terraform apply's local D1 API helper,
with the real database ID supplied by Terraform. Do not run Wrangler's local
placeholder database against production or run its local migration workflow
against the customer database.

### Updates, rollback, and uninstall

- Build and review the exact Worker/assets change before planning. Add future
  D1 schema changes as new, ordered migration files; do not edit an already
  applied migration. The Terraform migration runner is idempotent and verifies
  the migration ledger before route creation.
- Runtime values are initialized in D1 on the first apply. The dashboard can
  subsequently change runtime settings; Terraform does not overwrite existing
  dashboard settings on routine applies.
- For rollback, first plan and approve removal of the public route by setting
  `enable_public_route = false`. Verify origin traffic is restored, then plan
  and approve a Worker code/assets rollback. Preserve D1 and its data unless a
  separately reviewed retention/backup decision authorizes removal.
- For uninstall, inspect a saved Terraform plan and confirm it removes only
  this deployment's two Worker routes, Access application, Worker/subdomain,
  D1 database, and associated managed resources. Back up any required D1 data.
  Do not remove customer DNS records or the existing origin service; Terraform
  does not own them. Obtain explicit approval before applying any destroy plan.

Formatting and credential-free provider validation:

```sh
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

These commands validate configuration only; they do not plan against, apply to,
or provision a customer Cloudflare account.
