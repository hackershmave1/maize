# MAIZE branding and repository rename

## Approved direction

Use **MAIZE** as the project display name and `maize` as the GitHub repository
slug. Keep **The best defense is a good offense.** as the slogan.

## Scope

- Rename the existing GitHub repository in place, retaining history, issues,
  pull requests, and stars. Verify the new repository URL and update the local
  Git remote; do not push local commits.
- Update the main README, deployment guide, Cloudflare reference, contributor
  and security-policy headings, deployment prompt names/references, and current
  Cloudflare dashboard title, visible brand, and accessible home label.
- Remove the old branded README image rather than presenting it as a MAIZE
  logo. Do not generate new artwork or change inherited application assets.
- Use `maize` in clone-directory examples and example Terraform workspace
  names, but never rename live installation resources to match branding.
- Preserve upstream copyright/license attribution, npm scopes, existing
  infrastructure names, D1 migration identifiers, Durable Object identities,
  ownership markers, HMAC contexts, and secret/environment bindings.
- Historical design/implementation records may retain former project names;
  update links to renamed prompts so records do not have dangling references.
- Do not remove legacy code, change Cloudflare resources, deploy, or rewrite
  Git history. Preserve unrelated untracked local customization files.

## Verification

Add offline tests for current public branding, repository clone links, renamed
prompt paths, dashboard labels, and absence of the old README image. Run the
deployment tests, Worker regression suite, binding check, type-check, and
dashboard/Worker dry-run build. Verify GitHub's resulting name and permission
metadata without changing repository visibility.

## Naming limitations

The name is selected by the user; no trademark clearance or global uniqueness
claim is made. Renaming does not erase older commits or previously published
deployment details. Live dashboards keep their deployed branding until a
separately approved deployment updates them.
