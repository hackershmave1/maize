# Worker Route Flows Diagram Design

## Goal

Create a clear, reusable diagram that explains both the request-path change
caused by enabling Animal Pot's public Worker route and the staged deployment
sequence. The diagram is for app owners deciding whether to put the Worker in
front of an existing site.

## Format and location

Create a standalone, responsive SVG at `docs/worker-route-flows.svg` and link it
from `docs/DEPLOYMENT.md`. SVG is preferred over Mermaid because it allows
precise, readable side-by-side flows and can be opened or embedded on GitHub
without an external renderer.

## Diagram content

The top section compares two states:

1. **Route off (current / before activation):** browser requests pass through
   Cloudflare DNS/proxy to the existing application origin. The Animal Pot
   public route is not attached, so these requests do not traverse the Worker.
2. **Route on (after explicit activation):** every request to the protected
   hostname enters the Worker. Ordinary requests pass through to the existing
   origin; lure requests receive synthetic decoys; a source that reuses a
   decoy key is contained, follows the fake maze, and is blocked from the real
   app. The separate admin hostname is served by the Worker behind Cloudflare
   Access.

The bottom section shows the deployment sequence:

1. Bootstrap with `enable_public_route = false`: create the Worker, data and
   dashboard resources, including the Access-protected admin route, without
   changing public app traffic.
2. Review a new saved plan, explicitly approve it, then apply with
   `enable_public_route = true` to attach `protected-hostname/*`. This is a
   separate approval and affects the entire protected hostname.

Include a visible caution that disabling the route also requires its own
reviewed Terraform plan, and that routing changes are not a visual redesign or
edit to the app itself. Label flows as generic examples, not claims about the
live Cloudflare account.

## Visual and accessibility requirements

Use plain, audience-friendly labels and distinguish the route-off and route-on
states with both text and color. Keep arrows directional and label the
ordinary-traffic pass-through separately from decoy and containment branches.
Use sufficient contrast, a responsive viewBox, and SVG `<title>` and
`<desc>` elements.

## Scope and validation

Do not change Terraform, DNS, Workers, or app behavior. Do not imply that
bootstrap enables the public route. Validate SVG XML, inspect that all flow
labels and approval gates are present, and verify Markdown links to the SVG.
