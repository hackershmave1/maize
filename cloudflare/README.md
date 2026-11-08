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
npm run typecheck
npm run build
```

`npm run build` builds the Vite dashboard to `dashboard/dist` without source
maps, then runs Wrangler's local dry-run bundle check. It does not deploy or
provision Cloudflare resources. Production routing, including disabling the
alternate `workers.dev` route, is managed in Terraform.
