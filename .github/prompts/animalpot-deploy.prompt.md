---
mode: agent
description: Deploy Animal Pot in front of an existing site on the user's own Cloudflare account, through reviewed Terraform plans.
---

# Animal Pot deployment (generic)

Follow [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) to deploy one Animal Pot
installation with the Terraform module in `cloudflare/terraform`. Use that
guide's section letters when you report progress.

## Non-negotiable rules

- **Terraform is the only change path.** Use Cloudflare MCP tools only for
  read-only discovery and verification. Never use MCP writes, Wrangler deploy,
  ad-hoc API calls, or the dashboard to change Cloudflare configuration.
- **Every apply needs explicit approval of that exact saved plan.** Create the
  plan with `-out`, show the full `terraform show -no-color` output (summarise
  each create/update/replace/destroy), then stop and wait. Approval of one
  plan never approves another. Never use `-auto-approve`.
- **Never create or change DNS.** If a required record is missing or not
  proxied, tell the user exactly which record to create (guide section C3) and
  wait for them to confirm it exists.
- **Never handle secret values.** Do not ask the user to paste tokens or
  secrets into chat, and never print, echo, log, or write them to files.
  Ask the user to export `TF_TOKEN_app_terraform_io`, `CLOUDFLARE_API_TOKEN`,
  `MOQESH_LURE_KEY_SECRET`, and (if alerts are enabled)
  `MOQESH_ALERT_WEBHOOK_URL` themselves in the terminal you use, then check only
  that they are set (for example `test -n "$CLOUDFLARE_API_TOKEN" && echo set`).
- Never commit `terraform.tfvars`, plan files, or state. Never take over,
  replace, or delete an existing Worker route, origin Worker, or DNS record.

## Steps

1. **Collect inputs** (guide A to H): domain/zone, protected hostname, admin
   hostname, `origin_type` (`dns` for a normal server, `worker` plus the Worker
   name if the site is a Worker), Access team domain, operator emails,
   allowlisted IPs, whether webhook alerts are wanted, HCP Terraform
   organization name and workspace. Ask in one structured question where
   possible.
2. **Read-only discovery** with Cloudflare MCP: confirm the account and zone
   IDs; both hostnames exist in the zone as **proxied** records; no Worker
   route for exactly either hostname owned by another Worker and no
   path-specific wildcard route covering them; for `worker` mode, the origin
   Worker exists and is not the Animal Pot Worker. Stop and report any
   conflict.
3. **Explain whole-host impact** and get confirmation: once the public route is
   attached, every request to the protected hostname runs through the Worker;
   lure paths (`/.env`, `/.git/config`, `/config.json`, etc.) and the bait API
   are answered by the Worker; sources that reuse the leaked key are led
   through 10 fake API hops and then blocked from the real site.
4. **Local build and checks** in `cloudflare/`: `npm ci`, `npm test -- --run`,
   `npm run test:deployment`, `npm run check:bindings`, `npm run typecheck`,
   `npm run build`. Stop on any failure.
5. **Configure**: copy `terraform/examples/basic.tfvars.example` to
   `terraform/terraform.tfvars` and fill in the non-secret values, with
   `enable_public_route = false` and `agent_session_migration_applied = false`.
   Confirm the user set Execution Mode **Local** on the HCP Terraform workspace
   and exported the environment variables, then run `terraform init -input=false`.
6. **Bootstrap plan** (guide J): plan to `bootstrap.tfplan`, present it, and
   confirm it creates only Animal Pot resources and no route for the protected
   hostname. **Wait for approval**, then `terraform apply bootstrap.tfplan`.
   Require `terraform output d1_migrations_verified` and
   `terraform output worker_secret_bindings_verified` to be `true`. Ask the
   user to confirm they can log in at the admin hostname. Then set
   `agent_session_migration_applied = true`.
7. **Public route plan** (guide K): re-run route discovery, set
   `enable_public_route = true`, plan to `route.tfplan`, and present it.
   **Wait for separate approval**, then apply it.
8. **Verify** (guide L) without triggering containment: the normal site loads,
   `/.env` returns a synthetic decoy, and the admin hostname requires Access.
   Only run `cloudflare/scripts/demo_attack.py` if the user explicitly asks; it
   blocks their public IP.
9. **Report**: what was created, the output values (not secrets), and the
   day-2 table from guide M, including how to unblock a source and roll back
   by setting `enable_public_route = false` through another approved plan.
