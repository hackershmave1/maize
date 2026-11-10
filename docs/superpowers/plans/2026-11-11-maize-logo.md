# MAIZE Logo Implementation Plan

> **For agentic workers:** Use executing-plans to implement this approved plan inline.

**Goal:** Add the approved labyrinth logo and replace every former project-brand reference.

**Architecture:** A generated PNG lives in the current dashboard public assets;
README references that file and the legacy UI receives an identical copy.
Offline tests verify image links, format, and complete tracked-text cleanup.

**Tech Stack:** PNG, Markdown, React, Vite, Node test.

## Task 1: Regression tests

- [x] Update `cloudflare/terraform/test/branding.node.mjs` to require a README
  logo link, both dashboard image references and PNG favicons, matching PNG
  copies, and no former brand in tracked filenames or text.
- [x] Run `node --test cloudflare/terraform/test/branding.node.mjs`;
  expected failure before image integration and cleanup.

## Task 2: Generate and integrate

- [x] Generate one original M-shaped mint/cyan labyrinth on charcoal, with
  restrained amber accents, using the authorized image tool. Inspect the
  result, then copy it to `cloudflare/dashboard/public/maize-logo.png` and
  `web/public/maize-logo.png`.
- [x] Add this README image after the heading:

```html
<img src="cloudflare/dashboard/public/maize-logo.png" alt="MAIZE labyrinth logo" width="220">
```

- [x] Replace the Cloudflare dashboard's `M` mark with an image pointing to
  `/maize-logo.png`, `alt=""`, and existing 42px brand sizing. Use
  `<link rel="icon" type="image/png" href="/maize-logo.png" />` in both documents.
- [x] Replace the legacy sidebar image with `/maize-logo.png`, alt text
  `MAIZE logo`; set its document description/title to MAIZE.
- [x] Delete the obsolete JPG/SVG branded assets.

## Task 3: Full reference cleanup

- [x] Replace former-brand literals in historical docs and completed rename
  plan with MAIZE or neutral historical descriptions. Regression checks use
  a composed obsolete-label regex, not literal former branding.
- [x] Update the pending Cloudflare-only plan to retain the current logo and
  remove the duplicate legacy copy with `web/`.
- [x] Stage intended assets and text so the tracked-content scanner includes
  all new files, then run branding/deployment tests.

## Task 4: Verification

- [x] Inspect the PNG and validate signature, dimensions, equality of copies,
  README target, favicons, and sidebar image references.
- [x] Run `npm --prefix cloudflare run test:deployment`,
  `npm --prefix cloudflare run typecheck`, `npm --prefix cloudflare run build`,
  `npm --prefix web run build`, and `git diff --check`.
  Expected: pass; Worker build is a dry run and nothing deploys.
- [x] Commit only scoped changes with required co-author trailer. Do not push
  or merge without a separate choice.
