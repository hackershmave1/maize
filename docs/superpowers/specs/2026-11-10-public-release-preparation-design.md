# Public release preparation

## Approved direction

Sanitize the current project for public distribution and plan a Cloudflare-only
repository without the unused legacy application. The repository and project
rename remain a separate decision.

## Immediate cleanup

- Remove the route-flow SVG, its deployment-guide embed, and the two
  diagram-only design and implementation documents. Keep the textual
  explanation of bootstrap and separately approved route attachment.
- Add the exact slogan **The best defense is a good offense.** to the main
  README and deployment guide. Describe this as defensive deception on
  infrastructure the operator is authorized to protect, not retaliation.
- Replace deployment-specific domains, organization identifiers, resource
  names, and local deployment references throughout tracked documentation,
  scripts, configuration, examples, tests, and filenames with generic values.
  Use reserved example domains for examples and test fixtures. Public vendor
  documentation, package registries, license links, and upstream attribution
  are not customer deployment domains and remain.
- Require explicit HTTPS public and admin hostnames for the live demo. Missing
  or invalid arguments must produce an actionable error before any network
  request. Preserve the existing approval prompts, fixed request paths,
  redirect refusal, and no-automatic-retry behavior.
- Rename the customer-specific Terraform example and staging design document
  to generic names and update every tracked reference.
- Recast recorded staging acceptance as an anonymized historical record,
  clearly separate from verification of a new installation.
- Add an offline regression check for deployment-specific identifiers and
  diagram references. Include it in the existing CI without credentials,
  deployment, or external network calls.

## Cloudflare-only repository plan

Produce a separate implementation plan; do not delete the legacy application
as part of the immediate cleanup.

The plan will retain `cloudflare/`, its dashboard, migrations, staging origin,
Terraform, demo, and tests; the deployment guide; useful sanitized Cloudflare
design records; Cloudflare deployment prompts; and license and attribution.

The removal scope is the unused top-level Python application (`moqesh/`),
legacy dashboard (`web/`), backend tests, Docker and VPS deployment files,
Python packaging, legacy generators and tools, and Python-server-only guides.
Inspect tracked-file references before removal. If the current logo is kept,
move the README asset out of the legacy dashboard before deleting that tree.
No new logo is required.

Replace the legacy backend/frontend CI and Docker/agent release workflow with
the retained Cloudflare checks. Update contributing and security documentation
to describe the Worker, Access-protected dashboard, IP-based containment,
deployment verification, and responsible use. Remove obsolete links and
commands; do not claim Python sensors are compatible with the Worker API.

Existing legacy capabilities can be used separately through the upstream
project. Porting world generation or remote sensor ingestion into the Worker
would be new work, not a dependency of this release.

## Compatibility and safety

- Do not provision, deploy, change routes or DNS, apply Terraform, or modify
  live installation configuration.
- Do not rename deployed resources, npm scopes, database migration tables,
  Durable Object identities, HMAC contexts, or ownership markers. Removing
  unused Python code does not require these changes.
- Preserve the AGPL license and upstream copyright attribution.
- Do not push, merge, rename the GitHub repository, or rewrite Git history
  without separate authorization.
- Current-file cleanup cannot erase identifiers from existing commits,
  branches, releases, or externally cached copies. Report this limitation.
  Repository visibility is already public at the time of investigation.
- Keep new verification entirely local. No claim of staging acceptance or
  absence of secrets follows solely from a domain scan.

## Acceptance criteria

1. No tracked current file or filename contains the deployment-specific
   identifiers identified during investigation.
2. The removed route-flow artifact has no dangling references.
3. Both selected documentation entry points contain the exact slogan.
4. Demo help works offline; absent or invalid URLs fail before networking;
   configured examples use reserved domains.
5. Existing Worker, deployment, staging-origin, demo, binding, type-check,
   and dry-run build checks pass, including updated fixtures and references.
6. Terraform formatting and credential-free validation pass where the
   existing toolchain is available.
7. A separately reviewable Cloudflare-only implementation plan defines exact
   removals, retained assets, documentation and workflow updates, dependency
   checks, and verification before any legacy code is deleted.
