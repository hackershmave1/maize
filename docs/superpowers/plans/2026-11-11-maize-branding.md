# MAIZE Branding Implementation Plan

> **For agentic workers:** Use executing-plans to implement this approved plan inline.

**Goal:** Rename current public branding and the existing GitHub repository to MAIZE.

**Architecture:** Change documentation and dashboard display text only; retain
runtime compatibility identifiers. Rename GitHub in place and update the local
remote without pushing commits or deploying.

**Tech Stack:** Markdown, React/TypeScript, Node test, GitHub CLI.

## Task 1: Regression coverage

- [x] Create `cloudflare/terraform/test/branding.node.mjs`, testing README
  heading `# MAIZE`, current docs free of former display names, new prompt
  filenames, clone URL `https://github.com/hackershmave1/maize.git`, dashboard
  title `MAIZE Control Room`, accessible label, and visible `MAIZE` brand.
- [x] Run `node --test cloudflare/terraform/test/branding.node.mjs`.
  Expected: fail against former branding.

## Task 2: Current branding

- [x] Update `README.md`, `docs/DEPLOYMENT.md`, `cloudflare/README.md`,
  `CONTRIBUTING.md`, and `SECURITY.md` display names; preserve original author
  attribution and internal names.
- [x] Remove the old README logo embed; no new artwork is requested.
- [x] Rename `.github/prompts/animalpot-deploy.prompt.md` to
  `.github/prompts/maize-deploy.prompt.md` and the corresponding
  `animalpot-cloudflare-deploy.prompt.md` to `maize-cloudflare-deploy.prompt.md`.
  Update their content and all tracked links/command references.
- [x] Update dashboard markup:

```html
<title>MAIZE Control Room</title>
```

```tsx
<a className="brand" href="#detections" aria-label="MAIZE Control Room home">
```

  Set the visible brand text to `MAIZE`; retain the `M` mark.
- [x] Use `maize` in clone-directory and example workspace names. Clarify that
  existing deployment resource names need not match branding.
- [x] Adjust the pending Cloudflare-only removal plan: the old logo is not
  a MAIZE asset and should be deleted with the legacy dashboard, not moved.

## Task 3: Verification and commit

- [x] Run `npm --prefix cloudflare run test:deployment`,
  `npm --prefix cloudflare test -- --run`,
  `npm --prefix cloudflare run check:bindings`,
  `npm --prefix cloudflare run typecheck`, and
  `npm --prefix cloudflare run build`.
  Expected: pass; build is a dry run, not deployment.
- [x] Inspect references to former prompt paths and current branding.
  Historical project labels and upstream attribution may remain.
- [x] Commit only intended changes with the required co-author trailer.

## Task 4: Approved GitHub rename

- [x] Run:

```sh
gh repo rename maize --repo hackershmave1/moqesh --yes
git remote set-url origin https://github.com/hackershmave1/maize.git
gh repo view hackershmave1/maize --json name,url,isPrivate,viewerPermission
git ls-remote origin HEAD
```

  Expected: repository name `maize`, unchanged public visibility/admin
  permission, and working remote access. Stop and report errors explicitly.
- [x] Report that the rename is live but branding commits are local until
  separately authorized push/merge. Existing Cloudflare deployment is unchanged.
