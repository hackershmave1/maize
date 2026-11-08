---
mode: agent
description: Deploy and verify an Animal Pot Cloudflare installation through a reviewed Terraform plan.
---

# Animal Pot Cloudflare deployment

Guide one customer-owned deployment using the checked-in Terraform module in
`cloudflare/terraform`. Treat Cloudflare MCP as **read-only discovery and
verification**, never as a state manager, plan engine, or deployment tool.
Terraform is the only infrastructure apply path. Do not apply, provision,
deploy, change DNS, or write Cloudflare configuration unless the user has
reviewed the exact Terraform plan and explicitly approved that apply.

## 1. Discover without changing anything

Use the available Cloudflare MCP tools only for read-only inspection. Confirm:

- The selected account and zone IDs and the zone's domain.
- Both customer-provided hostnames already exist in that zone and are proxied.
- The protected hostname is the exact site hostname the user intends to put
  behind the Worker, and the admin hostname is distinct.
- Every existing Worker route that may overlap either hostname, including
  host-wide and more-specific path routes. **Stop if any route conflict or
  unclear ownership exists. Do not replace, delete, or adopt that route.**
- The named `ORIGIN` service and environment exist and refer to the customer's
  existing origin Worker—not this new Worker and not a service Terraform should
  create or delete.
- The requested Access team domain and exact operator email policy.
- That the customer accepts whole-host behavior: all requests to the protected
  hostname pass through the Worker, ordinary traffic uses `ORIGIN`, and
  configured lure paths are intercepted at the same URL.

Do not continue until the user confirms the complete host-wide behavior and
exact lure paths: `/.env` and the explicitly configured `BAIT_API_PATH`.
Terraform intentionally supports only these two lure paths; do not imply that
other paths are configured lures. Confirm the runtime durations, response
budget, allowlist, retention, alert webhook destination, staging target, and
the plan to keep `enable_public_route = false` until staging succeeds.

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
admin route. A failed migration or secret verification must halt before either
route is attached.

Create a saved Terraform plan and inspect it in full. Show the plan, including
resource additions, route patterns, Access policy, D1 database, Worker bindings,
provisioner changes, and any deletion/replacement, to the user. Confirm that it
does not manage DNS, an unrelated route, or the origin Worker. **Wait for the
user's explicit approval of that exact plan.** Only then apply that saved plan
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
Keep the public hostname route disabled until an equivalent staging deployment
has passed acceptance tests and received its own reviewed-plan approval.

## 4. Enable and verify the whole-host route

Before any route change, repeat read-only route discovery and stop on any new or
ambiguous conflict. Confirm with the user that enabling
`protected-hostname/*` affects the entire selected hostname, not just lure
paths. Set `enable_public_route = true` only for the explicitly approved
staging or production stage. Generate and show a new full Terraform plan, then
wait for separate explicit human approval before applying that exact saved
plan through Terraform.

After an approved apply, verify without changing state:

- The exact `protected-hostname/*` route points to the Moqesh Worker and the
  separate `admin-hostname/*` route remains Access-protected.
- Ordinary non-lure requests pass through to the existing origin service and
  return expected site content.
- `/.env` returns a synthetic decoy at that URL. The configured
  `BAIT_API_PATH` without the synthetic key returns the unauthorized decoy.
  Exercise key-reuse confirmation only in staging; never trigger a production
  maze/block just to test it.
- The admin hostname requires Cloudflare Access and the approved operator
  policy; the public hostname is not covered by that Access application.
- The Worker schedule matches Wrangler's `* * * * *` trigger.
- `workers.dev` and preview URLs are disabled; the existing origin and DNS
  records are unchanged; no unrelated routes were created, changed, or
  deleted.
- Terraform state contains resource metadata and secret binding names, not
  `LURE_KEY_SECRET`, `ALERT_WEBHOOK_URL`, or the Cloudflare API token.

## 5. Rollback and teardown ownership

For rollback, first show a plan that disables/removes only the public route,
wait for approval, and apply through Terraform. Verify traffic is back at the
origin before planning a Worker code/assets rollback. Preserve D1 data unless a
separately approved backup and retention decision authorizes deletion.

Never destroy or change DNS records or the existing origin service. Before
uninstall, show the complete Terraform destroy plan and identify only the
resources this module owns: its two routes, Access application, Worker and
subdomain settings, D1 database, and Terraform-managed configuration. Back up
needed D1 data and obtain explicit approval before applying any teardown plan.
