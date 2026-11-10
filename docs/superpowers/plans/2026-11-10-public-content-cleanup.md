# Public Content Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current tracked project generic and safe to demonstrate without customer-specific defaults.

**Architecture:** Sanitize examples and historical evidence, remove the unwanted diagram deliverables, and require explicitly selected demo origins. An offline Node deployment test scans current tracked files for previously identified private identifiers without reproducing those identifiers in its source.

**Tech Stack:** Markdown, Python unittest, Node test, Vitest, TypeScript, Terraform.

**Status:** Implemented and locally validated. No live deployment, push, merge,
or history rewrite was performed.

---

## Task 1: Public-content regression tests

**Files:** Create `cloudflare/terraform/test/public-content.node.mjs`;
modify `cloudflare/test/demo_attack_test.py`.

- [x] Add a repository scan using `git ls-files -z`, skipping deleted files and
  binary content. Tokenize text and filenames, hash tokens with SHA-256, and
  compare against fingerprints of the identified customer label and source IP.
  Reject private absolute home paths. Check diagram absence and slogan presence.
- [x] Add demo CLI tests for missing either origin, missing both origins, and
  invalid public or admin origins. Patch both `run_demo` and `build_opener` and
  assert neither is called on parser failure:

```python
with patch.object(demo, "run_demo") as run, patch.object(demo, "build_opener") as opener:
    with self.assertRaises(SystemExit) as raised:
        demo.main([])
    self.assertEqual(raised.exception.code, 2)
    run.assert_not_called()
    opener.assert_not_called()
```

- [x] Run from the repository root:

```sh
node --test cloudflare/terraform/test/public-content.node.mjs
python3 -m unittest discover -s cloudflare/test -p demo_attack_test.py -v
```

Expected: failures for current public identifiers and missing CLI enforcement.

## Task 2: Generic configuration and demo

**Files:** Modify `cloudflare/scripts/demo_attack.py`,
`cloudflare/staging-origin/wrangler.jsonc`, the route-preflight Terraform tests,
`cloudflare/terraform/test/config-consistency.node.mjs`,
`cloudflare/terraform/test/deployment-scripts.node.mjs`,
`cloudflare/test/staging-origin.node.mjs`, and demo fixtures.
Rename the customer-specific staging tfvars example to
`cloudflare/terraform/examples/staging.tfvars.example`.

- [x] Use `staging.example.com`, `admin-staging.example.com`,
  `moqesh-example-staging`, `moqesh-example-staging-events`, and
  `example-website` consistently in fixtures and examples.
- [x] Keep reserved example origins as in-memory offline demo fixture values,
  but require actual selection in the CLI:

```python
parser.add_argument("--base-url", type=https_origin, required=True,
                    help="Protected staging hostname origin (required)")
parser.add_argument("--admin-url", type=https_origin, required=True,
                    help="Admin dashboard origin (required)")
```

- [x] Preserve all existing transport safety checks. Reject equal public and
  admin origins before networking, with
  `parser.error("--admin-url must differ from --base-url")`.
- [x] Update existing unattended-input tests to provide both valid origins;
  update invalid-input tests to provide the other valid origin so validation
  rather than a missing argument causes rejection.
- [x] Run the two commands from Task 1 plus:

```sh
cd cloudflare
npm run test:deployment
npm run test:staging-origin
```

Expected: remaining public-content failures identify documentation not yet cleaned.

## Task 3: Documentation and unwanted artifact removal

**Files:** Modify `README.md`, `docs/DEPLOYMENT.md`, `cloudflare/README.md`,
`.github/prompts/animalpot-cloudflare-deploy.prompt.md`,
`cloudflare/test/staging-acceptance.md`, the rabbit-hole implementation plan,
and the Cloudflare context-handoff and webhook-alert design records.
Rename the customer-specific staging runner spec to
`docs/superpowers/specs/2026-11-09-staging-runner-design.md`.
Delete the standalone route-flow SVG and its two diagram-only planning records.

- [x] Add this exact line to both documentation entry points:

```markdown
**The best defense is a good offense.**
```

- [x] Explain authorized defensive deception, require both CLI URLs in every
  live-demo invocation, and clarify that the demo expects the bundled staging
  runner rather than arbitrary application HTML.
- [x] Generalize deployment hostnames, resource names, workspace names, and
  DNS examples. State that these are illustrative, not a currently deployed
  installation or pre-existing approval. Require fresh discovery and exact
  approval for every customer deployment.
- [x] Remove local absolute paths, actual source IPs, derived origin identity
  suffixes, deployment-specific plan fingerprints, and credential-expiry
  details from the historical acceptance record. Preserve observed outcomes
  and incomplete acceptance, explicitly identifying the record as historical.
- [x] Correct the README's release claim: legacy release automation still
  exists until the separate Cloudflare-only plan is executed.
- [x] Run the Task 1 commands. Expected: all pass.

## Task 4: Validation and separate removal plan

**Files:** Create `docs/superpowers/plans/2026-11-10-cloudflare-only-repository.md`;
modify this plan's completion checkboxes after validation.

- [x] Write the exact retained/removal inventory, asset migration, CI and
  release-workflow changes, documentation replacements, compatibility
  boundaries, and verification commands. Do not execute legacy removal.
- [x] Run:

```sh
cd cloudflare
npm test -- --run
npm run test:deployment
npm run test:staging-origin
npm run check:bindings
npm run typecheck
npm run build
cd ..
python3 -m unittest discover -s cloudflare/test -p demo_attack_test.py -v
python3 cloudflare/scripts/demo_attack.py --help
git diff --check
```

Expected: tests/checks pass; build is a Wrangler dry run, not deployment.
- [x] Use the existing Terraform 1.10.5 executable for `fmt -check -recursive`
  and `init -backend=false -input=false` followed by `validate` where existing
  provider/tool dependencies are available. Do not use customer credentials
  or initialize a remote backend.
- [x] Use the existing Ruff installation to lint and format-check the Python
  demo/tests. If a validator is unavailable, report the gap rather than claim
  success.
- [x] Commit only intended cleanup, tests, and plan files with the required
  co-author trailer. Do not push, merge, rewrite history, or change deployment.

## Local verification record

- Worker suite: 113 passing tests.
- Deployment suite: 43 passing tests, including the public-content scan.
- Staging-origin suite: 15 passing tests.
- Demo suite: 26 passing tests; command-line help verified offline.
- Binding check, type-check, and dashboard/Worker dry-run build passed.
- Ruff lint and format checks passed using `uv tool run --from ruff ruff`.
- Terraform format and credential-free validation passed using isolated
  writable validation data; existing shared Terraform data was not modified.
- Changed route-preflight Terraform fixtures: 6 passing local tests.
- The Cloudflare-only removal plan was written but not executed.
