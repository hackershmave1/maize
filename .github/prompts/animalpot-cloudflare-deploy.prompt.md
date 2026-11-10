---
mode: agent
description: Deploy and verify an Animal Pot Cloudflare installation through a reviewed Terraform plan.
---

# Animal Pot Cloudflare deployment

Guide one customer-owned deployment using the checked-in Terraform module in
`cloudflare/terraform`. Treat Cloudflare MCP as **read-only discovery and
verification**, never as a state manager, plan engine, or deployment tool.
Terraform is the only infrastructure apply path. Do not apply, provision, or
deploy unless the user has reviewed the exact Terraform plan and explicitly
approved that apply. Do not create or change DNS unless the user has reviewed
and explicitly approved the exact DNS change separately from Terraform plans.
Do not write Cloudflare configuration outside these approved steps.
An approval for one plan never approves a later plan or a DNS change. If the
requested work is documentation-only or local validation, do not make
Cloudflare API calls or run Terraform plan/apply.

For the approved Kurocyber staging action, scope all work exclusively to
`staging.kurocyber.com` and `admin-staging.kurocyber.com`. Never modify
production Workers, D1 databases, Durable Object namespaces, secrets, DNS,
routes, `kurocyber.com`, `www.kurocyber.com`, or the existing wildcard route.
Production is out of scope and needs separate discovery, state, plan, and
explicit consent.

## 1. Discover without changing anything

Use the available Cloudflare MCP tools only for read-only inspection. Confirm:

- The selected account and zone IDs and the zone's domain.
- Both customer-provided hostnames already exist in that zone and are proxied.
- The protected hostname is the exact site hostname the user intends to put
  behind the Worker, and the admin hostname is distinct.
- Every existing Worker route that may overlap either hostname, including
  host-wide and more-specific path routes. **Stop if an exact-host conflict or
  unclear ownership exists. Do not replace, delete, or adopt a route.** For
  Kurocyber staging, the existing `*.kurocyber.com/*` route is expected and
  must remain unchanged; verify that only the approved, more-specific exact
  staging routes are planned and that no wildcard edit is proposed.
- For a normal deployment, the named `ORIGIN` service and environment exist
  and refer to the customer's existing origin Worker—not this new Worker and
  not a service Terraform should create or delete. For the approved Kurocyber
  staging action, use the separate static origin selected by
  `create_staging_origin = true`; do not bind production as the origin.
- The requested Access team domain and exact operator email policy.
- For Kurocyber staging, verify the current DNS state for both exact hostnames
  before any Terraform plan/apply. Terraform does not create DNS. If either
  record is missing or unproxied, stop and propose a separate DNS change for
  explicit approval; do not treat Terraform-plan approval as DNS approval.
- For Kurocyber staging, verify one access-controlled HCP Terraform workspace
  and state is the sole writer for the `(lower(account_id), installation_id)`
  pair. Never manage the same pair or derived static-origin Worker name from
  another state/workspace.
- That the customer accepts whole-host behavior: all requests to the protected
  hostname pass through the Worker, ordinary uncontained traffic is forwarded
  to `ORIGIN` without event logging, and configured lure paths are intercepted
  at the same URL. Explain that this still runs the Worker on ordinary traffic;
  it is not lure-path-only routing.

Do not continue until the user confirms the complete host-wide behavior and
exact lure paths: `/.env` and the explicitly configured `BAIT_API_PATH`.
Terraform intentionally supports only these two lure paths; do not imply that
other paths are configured lures. Confirm the runtime durations, response
budget, allowlist, retention, alert webhook destination, and staging target.
The current Terraform binding sets `ALERT_DIRECT_LURE = false`; an allowlisted
direct-lure request is recorded but does not send its own webhook alert or
start containment.

## 2. Prepare safely

- Never commit `.tfvars` or expose customer configuration in public logs/plans.
  Keep real account/zone IDs and customer data in private local tfvars and the
  protected remote state. Never put API tokens or secret values in chat,
  source control, Terraform inputs, tfvars, plans, or logs.
- Verify that the customer has a protected remote HCP Terraform workspace,
  configured for local execution so the local Worker/assets build and the
  Terraform local provisioning helpers are available. Confirm that state
  access is restricted and auditable.
- Use a narrowly scoped `CLOUDFLARE_API_TOKEN` environment variable. It needs
  only the read/write permissions for the selected zone/account required by
  the pinned resources and provisioning helpers; DNS write is not required.
- Obtain `MOQESH_LURE_KEY_SECRET` and `MOQESH_ALERT_WEBHOOK_URL` from the
  customer's protected environment or secret manager. The lure key must be
  unique to this installation and at least 32 bytes; the webhook must be HTTPS.
  Terraform's apply helper uploads and verifies these Worker secrets without
  putting their values in Terraform inputs or state. Bump the non-secret
  `secret_rotation_revision` when rotating either value.
- Copy `terraform/examples/basic.tfvars.example` to an ignored
  `terraform/terraform.tfvars`; replace all placeholders and verify that
  `lure_paths` contains only `/.env` and the configured `bait_api_path`.
- For Kurocyber staging, instead copy
  `terraform/examples/kurocyber-staging.tfvars.example`. Preserve its isolated
  Worker (`moqesh-kurocyber-staging`) and D1
  (`moqesh-kurocyber-staging-events`) names, set a stable unique non-secret
  `installation_id`, and keep `create_staging_origin = true`. Leave
  `origin_service_name` empty so `ORIGIN` binds to the generated static origin.
  That Worker name is `moqesh-staging-origin-` plus the first 16 lowercase hex
  characters of SHA-256 over `lower(account_id) + ":" + installation_id`
  (38 characters total). Never reuse production resources or secrets.
- Build and locally validate the same source/assets that Terraform will upload.
  Run `npm run test:deployment`, `npm run check:bindings`, the Worker tests,
  typecheck, and `npm run build`.

## 3. Stage schema, secrets, and Access before public routing

Keep `enable_public_route = false` for the first apply. Terraform must use
`cloudflare_d1_database.events.id` for the Worker binding and migrations; never
use Wrangler's local placeholder D1 ID. The apply runs the actual D1 migration
helper and verifies migrations `0001_events.sql`, `0002_admin.sql`, and
`0003_containment_sources.sql`, initializes runtime settings without
overwriting existing dashboard values, uploads/verifies the secret bindings,
configures the `* * * * *` scheduled trigger, and creates the Access-protected
admin route. For Kurocyber staging, the bootstrap plan also creates the
private static-origin Worker and its assets, with no public staging site
route, DNS, production resources, or wildcard changes. Both proxied DNS
records must already exist before planning. A failed migration or secret
verification must halt before either route is attached.

For Kurocyber staging, the expected DNS records to propose (never create
without separate explicit DNS approval) are:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `staging` (`staging.kurocyber.com`) | `kurocyber.com` | Proxied |
| CNAME | `admin-staging` (`admin-staging.kurocyber.com`) | `kurocyber.com` | Proxied |

Do not assume these records are currently present. The static origin must only
serve the staging hostname through Moqesh's `ORIGIN` service binding; its
hostname guard must reject `workers.dev` and unknown hosts. Lure and
contained-source responses must not reach it, while ordinary uncontained
requests must pass through. The origin-ownership preflight is a read-only
Workers Scripts API lookup requiring `CLOUDFLARE_API_TOKEN` with Workers
Scripts Read in addition to the apply credentials. It must fail closed on API
errors or ambiguous responses. Do not invoke that guard or make real API
calls before the explicit deployment step and exact-plan approval.

Create a saved Terraform plan and inspect it in full. Show the plan, including
resource additions, route patterns, Access policy, D1 database, Worker bindings,
provisioner changes, and any deletion/replacement, to the user. Confirm that it
does not manage DNS, an unrelated route, or an external existing origin
Worker. For Kurocyber staging, confirm it includes only the approved
installation's private static-origin Worker and no production or wildcard
changes. **Wait for the user's explicit approval of that exact plan.** Only
then apply that saved plan
with Terraform; never use `-auto-approve`, Cloudflare MCP writes, Wrangler
deploy, standalone API mutations, or another provisioning tool. Only the
checked-in helper scripts invoked by the approved Terraform apply may call the
Cloudflare API for D1 migrations and Worker secrets.

Verify the migration ledger and settings using read-only Terraform outputs or
read-only Cloudflare MCP discovery. Require
`terraform output d1_migrations_verified` and
`terraform output worker_secret_bindings_verified` to both be `true`. Verify
the secret binding names, not values.
Access must protect only the admin hostname with the confirmed email policy.
Keep the production hostname route disabled until an equivalent staging
deployment has passed acceptance. A staging hostname requires its own separate
reviewed plan to attach the public route for live acceptance; that staging
approval does not authorize or enable a production route. For the Kurocyber
staging action, production remains entirely out of scope even after staging
acceptance; do not proceed to a production plan or modify production state.

## 4. Enable and verify the whole-host route

Before any route change, repeat read-only route discovery and stop on any new or
ambiguous conflict. Confirm with the user that enabling
`protected-hostname/*` affects the entire selected hostname, not just lure
paths: ordinary uncontained requests still traverse the Worker before they are
forwarded to `ORIGIN`, without event logging. First set
`enable_public_route = true` only for the explicitly approved staging target,
generate and show a new full Terraform plan, then wait for separate explicit
human approval before applying that exact saved plan through Terraform.
Proceed to production only after staging acceptance is documented and
reviewed. Production requires fresh discovery, production-specific state and
configuration, a separate full plan, and a separate explicit approval.
For a Kurocyber staging action, stop after staging acceptance; never execute
the production step or make any production change.

After an approved apply, verify without changing state:

- The exact `protected-hostname/*` route points to the Moqesh Worker and the
  separate `admin-hostname/*` route remains Access-protected.
- Ordinary non-lure requests pass through to the existing origin service and
  return expected site content. For Kurocyber staging, they reach only the
  private static origin through the `ORIGIN` binding; lures and contained
  sources must not reach it.
- `/.env` returns a synthetic decoy at that URL. The configured
  `BAIT_API_PATH` without the synthetic key returns the unauthorized decoy.
  Exercise key-reuse confirmation only in staging; never trigger a production
  maze/block just to test it.
- An allowlisted direct-lure request is recorded without a direct-lure alert
  under the current `ALERT_DIRECT_LURE = false` binding. Confirmed-key alerts
  remain enabled.
- The admin hostname requires Cloudflare Access and the approved operator
  policy; the public hostname is not covered by that Access application.
- The Worker schedule matches Wrangler's `* * * * *` trigger.
- `workers.dev` and preview URLs are disabled; the existing origin and DNS
  records are unchanged; no unrelated routes were created, changed, or
  deleted.
- Terraform state contains resource metadata and secret binding names, not
  `LURE_KEY_SECRET`, `ALERT_WEBHOOK_URL`, or the Cloudflare API token.
- If the exact staging route is disabled or removed, rediscover matching
  routes, DNS, and custom domains to determine the fallback. A wildcard route
  might not exist; do not create one. Do not claim that route removal restores
  the private static origin; verify and report the actual fallback before any
  route rollback.

## 5. Rollback and teardown ownership

For rollback, first show a plan that disables/removes only the public route,
wait for approval, and apply through Terraform. For Kurocyber staging, verify
the actual fallback against current routes, DNS, and custom domains; do not
assume a wildcard exists or traffic is back at the private static origin.
Preserve D1 data unless a separately approved backup and retention decision
authorizes deletion.

Never destroy or change DNS records or an external existing origin service.
For Kurocyber staging, the private static origin is Terraform-managed and may
be changed or removed only if it is explicitly listed in the reviewed plan for
that staging installation. Before uninstall, show the complete Terraform
destroy plan and identify only the resources this module owns: its two routes,
Access application, Moqesh and staging-origin Workers/subdomain settings, D1
database, and Terraform-managed configuration. Back up needed D1 data and
obtain explicit approval before applying any teardown plan.
