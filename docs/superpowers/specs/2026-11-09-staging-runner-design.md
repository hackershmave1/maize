# Isolated Staging Runner Design

**Status:** Approved
**Date:** 2026-11-09
**Project:** `hackershmave1/moqesh`

This historical design uses illustrative hostnames and resource names.
It is not an approval or deployment record for a reader's installation.

## Goal

Create a small, isolated website origin for testing the Moqesh Cloudflare
deployment. The staging website is an original, static endless-runner game. It
is not a copy of a production website or Google Chrome's dinosaur game.
The staging hostname is protected by a separate Moqesh staging installation;
the live production site remains unchanged.

## Approved scope

- Public staging hostname: `staging.example.com`.
- Access-protected staging admin hostname: `admin-staging.example.com`.
- A separate static-origin Worker serves the game assets. The Moqesh staging
  Worker uses an `ORIGIN` service binding to forward ordinary, uncontained
  requests to this origin Worker.
- The admin hostname is protected by Cloudflare Access and serves the Moqesh
  staging dashboard/API from the same Moqesh staging Worker. Admin requests do
  not pass through to the game origin.
- Staging and production use separate Workers, Terraform state/workspaces,
  configuration, D1 databases, Durable Object namespaces, and secrets.
- Production hostnames `example.com` and `www.example.com` are not changed
  or routed through Moqesh as part of this staging work.
- Any existing wildcard route remains unchanged. Exact staging-host routes
  are intended to take precedence for
  only the two selected hostnames.

## Game experience

The origin is a self-contained static page with an original small explorer
robot and a visual treatment distinct from Google's game. It has:

- Endless-runner jump gameplay using Space, Arrow Up, and touch/tap controls.
- A score, game-over state, and restart action.
- Best score persisted locally in the browser.
- No login, backend, external asset host, analytics, or third-party requests.
- Responsive layout and keyboard/touch operation.

The game is a harmless test origin used to verify normal pass-through, lure
interception, containment responses, and staging latency. It does not execute
code, access user data, or depend on the production site.

## Request flow

1. A visitor opens `staging.example.com`; its proxied DNS record sends traffic
   through Cloudflare.
2. The exact staging route invokes the Moqesh staging Worker. The more-specific
   route must not affect other subdomains using the existing wildcard route.
3. Ordinary, uncontained requests are forwarded through the `ORIGIN` service
   binding to the static staging-origin Worker and receive the game page.
4. Configured lure paths and confirmed-source maze/block responses are handled
   by Moqesh and do not reach the origin.
5. An operator opens `admin-staging.example.com`; Cloudflare Access
   authenticates the operator before the request reaches the admin surface on
   the Moqesh staging Worker.

The origin Worker is an internal service-binding target, not an additional
public website hostname. `staging.example.com` and
`admin-staging.example.com` still require proxied DNS records before their
routes can be exercised. The current Terraform module does not manage DNS, so
DNS preparation is a separate, explicitly reviewed change.

## Terraform and route safety

The staging-origin Worker must be Terraform-managed so the approved
infrastructure plan remains the only provisioning path. Terraform will upload
the static assets and bind the Moqesh staging Worker to the staging origin
service. This must not replace or modify the existing `example-website`
Worker.

The original deployment preflight treated a wildcard route as an overlap and
rejected intended staging routes. The implemented check models Cloudflare route
matching: a more-specific exact-host route can take precedence over a
wildcard route, while a conflicting exact route or unclear ownership remains a
hard stop. Tests cover staging/admin subdomains, the apex, exact conflicts,
and unrelated hostnames. Do not remove or reassign an existing wildcard route.

An installation may have production Custom Domain Workers; discover them
without changing them. Cloudflare documents that a route can run before a Custom
Domain Worker and invoke that origin; this staging design instead uses a
distinct static origin Worker and does not depend on production traffic.

## Deployment and approval gates

- Read-only discovery must confirm the staging hostnames, proxied DNS records,
  Access operator policy, origin service, and current route ownership.
- Do not create DNS records, change the existing wildcard route, attach a
  public route, or apply Terraform without showing the exact proposed changes
  and receiving the required explicit approval.
- Bootstrap staging with the public staging route disabled. Review and approve
  the exact saved Terraform plan before applying.
- Verify the origin Worker, migrations, secrets, Access policy, admin route,
  and disabled `workers.dev`/preview entry points.
- Enable `staging.example.com/*` only in a second saved plan after bootstrap
  verification; obtain separate approval for that exact plan.
- Record staging acceptance, latency/usage, and rollback evidence. Production
  deployment is not part of this design and requires separate planning and
  approval.

## Acceptance criteria

- The game loads on the staging origin and works without network access beyond
  the initial page/assets.
- Space, Arrow Up, and touch/tap trigger jumps; collision ends the run; restart
  works; best score survives a reload in the same browser.
- The staging Moqesh Worker returns the origin page for ordinary requests and
  does not create an ordinary-request event.
- Configured lure and confirmed-source behavior remains in the Moqesh Worker
  and does not invoke the origin when interception is expected.
- Anonymous or unauthorized requests to the admin hostname are denied by
  Access; an approved operator can reach the staging dashboard.
- The production apex, `www`, existing Worker custom domains, and wildcard
  route remain unchanged.
- Terraform route-preflight tests allow only the intended specific staging
  routes and continue to reject true conflicts.

## Out of scope

- Copying or mirroring a production website.
- Reproducing Google Chrome's dinosaur game, character artwork, branding, or
  distinctive presentation.
- Changing production DNS, routes, Workers, or website content.
- Deploying any Cloudflare resource before the exact Terraform plans and any
  required DNS changes are reviewed and explicitly approved.
