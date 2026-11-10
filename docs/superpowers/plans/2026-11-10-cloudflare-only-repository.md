# Cloudflare-Only Repository Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unused self-hosted application and its release automation while preserving the working Cloudflare product.

**Architecture:** Keep the Worker, dashboard, D1 migrations, Durable Objects, staging origin, Terraform, demo, and their tests in `cloudflare/`. Delete the independent Python server and legacy SPA rather than porting them. Preserve licensing and compatibility-sensitive infrastructure identifiers.

**Tech Stack:** Cloudflare Workers, TypeScript, React/Vite, D1, Durable Objects, Terraform, Node test/Vitest, Python stdlib demo and unittest.

**Status:** Plan only; legacy removal has not been executed or authorized by this document.

**Prerequisite:** Complete the public-content cleanup and retain passing local
validation. The repository/project rename is deliberately outside this plan.

---

## Retained files

- The complete `cloudflare/` tree, including its dependency lockfile and
  Terraform provider lockfile.
- `README.md`, `LICENSE`, `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`, `.gitignore`.
- `docs/DEPLOYMENT.md` and useful sanitized Cloudflare design/plan records.
- `.github/workflows/cloudflare.yml` and both Cloudflare deployment prompts.
- No legacy logo is retained: the MAIZE README no longer embeds the old
  branded image, which can be removed with the unused dashboard.

No existing Worker name, npm scope, database migration table, HMAC context,
Durable Object identity or migration, secret binding, or ownership marker is
renamed. Those are separate migration decisions, not reasons to retain Python.

## Task 1: Verify boundaries and establish a baseline

**Files to inspect:** `cloudflare/package.json`,
`cloudflare/dashboard/vite.config.ts`, `cloudflare/tsconfig.json`,
`.github/workflows/cloudflare.yml`, `README.md`.

- [ ] Confirm a clean worktree and review current branch and tracked paths:

```sh
git status --short --branch
git ls-files cloudflare .github docs README.md
git grep -n -E 'web/|moqesh/|pyproject|Dockerfile|deploy/' -- cloudflare .github/workflows/cloudflare.yml
```

Expected: no legacy filesystem imports or required build paths. Npm scopes
such as `@moqesh/cloudflare` are names, not filesystem dependencies.
If a real dependency is discovered, resolve its ownership explicitly before
removing files.

- [ ] Establish the retained baseline:

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
```

Expected: all pass; the build is dry-run only. Do not deploy.

## Task 2: Preserve Python lint configuration

**Files:** Create `ruff.toml`. The old logo remains only in the unused legacy
dashboard until Task 3 removes that directory; do not migrate it as MAIZE artwork.

- [ ] Preserve the lint settings currently provided by Python packaging in
  a standalone `ruff.toml`, so deleting packaging does not silently change CI:

```toml
line-length = 120
target-version = "py311"

[lint]
select = ["E", "F", "I", "UP", "B"]
```

The FastAPI-specific `B008` exception is no longer needed for the stdlib demo.
- [ ] Run `ruff check cloudflare/scripts cloudflare/test` and
  `ruff format --check cloudflare/scripts cloudflare/test`.
  Expected: both pass with the standalone settings.

## Task 3: Remove only the unused application and its automation

**Removal inventory:**

- `moqesh/`: Python honeypot/API, world generation, agents and log shippers.
- `web/`: legacy SPA and old branded assets.
- `tests/`: Python-server tests, not `cloudflare/test/`.
- `deploy/`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`.
- `.env.example`, `pyproject.toml`.
- `scripts/build_profile.py`, `scripts/genbig.py`.
- `tools/build_template_dll.md`, `tools/simulate_agent.py`.
- `docs/CONFIGURATION.md`, `docs/SENSORS.md`, `docs/WORLDSMITH.md`.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`.

- [ ] Inspect this exact inventory with `git ls-files` and confirm it matches
  the reviewed removal scope.
- [ ] Remove the reviewed tracked files with:

```sh
git rm -r -- moqesh web tests deploy
git rm -- Dockerfile docker-compose.yml .dockerignore .env.example pyproject.toml
git rm -- scripts/build_profile.py scripts/genbig.py
git rm -- tools/build_template_dll.md tools/simulate_agent.py
git rm -- docs/CONFIGURATION.md docs/SENSORS.md docs/WORLDSMITH.md
git rm -- .github/workflows/ci.yml .github/workflows/release.yml
```

These commands act on tracked files only. Do not recursively remove the
repository, worktree, private deployment data, or ignored local environments.
The old agents are not compatible with the Worker's admin API; their removal
does not disable any current Worker feature.

- [ ] Keep the existing Cloudflare workflow as the sole CI workflow. It runs
  Worker/dashboard/Terraform checks, public-content checks, and offline demo
  tests with no deployment credentials. Do not add automatic deployment or
  publish obsolete Docker images/agent binaries under future version tags.
- [ ] Review repository branch-protection required checks in GitHub. Retire
  legacy backend/frontend check requirements only through separately approved
  settings changes, so removing jobs does not leave an unmergeable PR.

## Task 4: Update contributor and product documentation

**Files:** Modify `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.gitignore`.

- [ ] Remove the README legacy-code paragraph and temporary release warning.
  Keep the upstream attribution, AGPL notice, slogan, deployment guide,
  architecture, and known limitations. Point self-hosted/sensor users to the
  upstream project instead of suggesting those capabilities exist here.
- [ ] Replace contributing setup with Node.js 22+, npm, Terraform 1.10+, and
  Python 3.11+ for the offline demo tests. Use the exact baseline commands from
  Task 1 and `ruff check`/`ruff format --check` for Python linting.
- [ ] Explain that contributors use local tests and dry-run builds by default.
  Real provisioning, DNS/route changes, and live demos need their existing
  separate approvals and staging safety gates.
- [ ] Replace obsolete security assumptions about sensors, ingestion, and
  bundles with current Worker behavior: fake data only, authorized deployment,
  IP-based containment and shared-NAT effects, Access JWT audience/signature
  checks, same-origin mutation checks, private secret handling, D1 retention,
  and fail-open/fail-closed behavior as implemented and tested. Preserve
  private vulnerability reporting instructions.
- [ ] Remove obsolete `.gitignore` entries for `web/`, generated DLLs, legacy
  bundles/agent binaries, and server databases only where they have no retained
  use. Keep credential, Terraform state/plan/tfvars, `.dev.vars`, npm/build,
  Python cache, virtual environment, and worktree exclusions.
- [ ] Verify no documentation/workflow refers to deleted execution paths:

```sh
git grep -n -E 'web/|moqesh/|Dockerfile|docker-compose|uv pip|pytest|release.yml|docs/(CONFIGURATION|SENSORS|WORLDSMITH)' -- README.md CONTRIBUTING.md SECURITY.md docs/DEPLOYMENT.md cloudflare .github
git diff --check
```

Expected: no stale live instructions. Upstream links, license attribution,
and the retained npm scopes are intentional, not stale paths.

## Task 5: Validate and hand off

- [ ] Repeat all baseline checks from Task 1, Python lint/format checks, and
  `python3 cloudflare/scripts/demo_attack.py --help`.
- [ ] Run `terraform fmt -check -recursive`, then credential-free
  `terraform init -backend=false -input=false` and `terraform validate`
  in `cloudflare/terraform`. Never initialize or apply customer state.
- [ ] Review the staged diff and confirm:
  - Every retained Cloudflare file still exists.
  - No current runtime import or documentation link points to removed code.
  - No README image refers to deleted legacy assets.
  - License and attribution remain unchanged.
  - No public deployment-specific identifiers were introduced.
  - No live resources, DNS, routes, or GitHub settings were changed.
- [ ] Commit the scoped result with the required co-author trailer and submit
  it for review. Push/PR/merge remain separately authorized actions.

## Deferred decisions

The project name is now MAIZE; new logo artwork remains a separate decision.
Old public commits, branches, tags, releases, and cached copies may
still contain removed identifiers or legacy code; this plan does not rewrite
history or claim to erase prior exposure.

Porting original Moqesh world generation, CTF scenarios, remote sensor
ingestion, or AI analysis into the Worker is new product development. None is
required for the current edge lures, rabbit hole, containment, or dashboard.
