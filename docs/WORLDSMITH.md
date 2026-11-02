# Worldsmith: the AI World builder

The **worldsmith** is an AI agent that **builds and evolves the content of the
[World](#what-the-world-is)**: a realistic site made of several static, inert portals +
a **lure** placed on the attacker's hunting path. It is invoked **on demand** (not per
request): it provisions or refreshes the content and stops.

> Not to be confused with `moqesh/agent/`, which is the **remote sensor** (edge). The worldsmith
> (`moqesh/worldsmith/`) **produces files**; the sensor reports hits.

## Safety principle (non-negotiable)

Moqesh **only serves static bytes and never executes** the portals' content. The
worldsmith therefore produces **exclusively inert static files** (HTML/CSS/JS/
JSON/SVG/...), and that is **enforced mechanically**, not entrusted to the prompt:

1. **Per-write validation** (`validate.py`): every file goes through a safe path (no
   traversal/absolute paths, extension allowlist), **no server-side code** (`<?php`,
   `<% %>`, `{% %}`, shebangs), **no external loads/callbacks** (everything *same-origin*: the
   "logins" post to the Moqesh gate, not to an external backend or domain), and size limits.
2. **Final gate**: before publishing, the **entire tree** on disk is **re-validated**. If anything
   fails, **nothing is published** and the live World stays intact.
3. **Atomic publish**: the build is assembled in a *staging* directory and swapped in one step.

The content may include **fabricated** secrets/credentials (they are the lure); the
"only one live credential" invariant is enforced by `plant_bait`, not by the inertness validator.

## What the World is

A tree of real files + `manifest.json` that mounts one or more **portals** under
different URL prefixes (like a server hosting several sites):

```
world/
  manifest.json                 # {"mounts":[{"prefix":"/docs","dir":"sites/docs","spa":false}, ...]}
  sites/console/index.html      # portals: static files + mock data (api/*.json)
  sites/docs/index.html
  sites/status/summary.json
```

Health/status endpoints can use dynamic tokens that **Moqesh fills in when serving**
(so they do not look "frozen"): `{{moqesh.now_iso}}`, `{{moqesh.uptime_seconds}}`,
`{{moqesh.minutes_ago}}`. See [`MOQESH_WORLD_*`](CONFIGURATION.md#content-generation).

## Hunting-path doctrine (the lure)

A **goal-driven** pentest agent (Strix/PentAGI style) always enumerates looking for the same things:
an **environment backup with credentials** (`/.env`, `/.env.bak`, `/env.bak`, `/api/env.bak`...),
an **admin/ops console** (`/ops`, `/admin`, `/internal/ops`...) and a **login** to post to
(`/api/login`, `/auth/login`...). The worldsmith plants the lure **right there** with `plant_bait`:

- **one single live credential** (a honeytoken);
- the backup (leak) is exposed on those paths and includes the `{{cred:KEY}}` placeholder and the gate URL;
- the console (gate) requires that token (401 Bearer without it; 200 with it);
- `robots.txt` reveals the paths as a decoy.

When the attacker reuses the token against the gate, Moqesh fires **`credential_reuse`** and
**blocks** them. The lure is imported as the active scenario (see [scenarios](CONFIGURATION.md)).

## Providers

Configurable with `MOQESH_WORLDSMITH_PROVIDER` (or `--provider`):

| Provider | AI | Notes |
|----------|----|-------|
| `stub` | no | Deterministic, zero cost. Builds a valid World + lure. Ideal for tests and as the default build without AI. |
| `api` | Anthropic Messages API | A *tool-use* loop with **our tools** (`write_file`, `set_manifest`, `plant_bait`...). **It has no shell**: the model can only call those sandboxed tools, so it cannot pivot. Requires `MOQESH_WORLDSMITH_API_KEY`. |
| `claude_cli` | `claude` CLI (subscription) | A confined `claude -p` subprocess (`Read,Write,Edit`, no bash/network, `--add-dir` to the staging dir). It builds via files + a `_worldsmith_bait.json` that we ingest through `plant_bait`. Requires CLI auth or `CLAUDE_CODE_OAUTH_TOKEN`. |

The `api` provider's tools **never raise**: they return `{"ok": false, "reasons": [...]}`
so the agent can **self-correct**. Every write is validated; the sandbox caps the number of
files and bytes.

## Usage (CLI)

```bash
# New build (provider from config, or --provider)
python -m moqesh.worldsmith build --brand "Harborline" --profile saas

# Evolve the current World (rotates the lure, refreshes mock data, adds/varies a portal)
python -m moqesh.worldsmith evolve

# Options: --provider stub|api|claude_cli  --model  --brand  --profile
#          --goal  --portals N  --world-path PATH  --no-import-bait  --json
```

The build publishes the World (if it passes validation) and **imports the lure pack** as the active
scenario. **Restart/reload the honeypot process** so it serves the new World (the World is
loaded at startup).

### `api` provider (Anthropic)

```bash
export MOQESH_WORLDSMITH_PROVIDER=api
export MOQESH_WORLDSMITH_API_KEY=sk-ant-...
export MOQESH_WORLDSMITH_MODEL=claude-sonnet-4-5   # optional
python -m moqesh.worldsmith build --brand "Harborline"
```

### `claude_cli` provider (subscription)

Generate a long-lived token with your subscription and pass it through the environment:

```bash
claude setup-token            # interactive flow (browser); prints an sk-ant-oat...
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
python -m moqesh.worldsmith build --provider claude_cli --brand "Harborline" --profile saas
```

The CLI writes the World files + `manifest.json` + a `_worldsmith_bait.json` (a build artifact
with the lure spec; it is **not** published: it is ingested through `plant_bait` and deleted).

> **Isolation (important).** Run any AI build in a **clean** environment (no real SSH keys
> or `.env` files in the accessible `$HOME`/cwd). The `api` provider has no shell; the
> `claude_cli` one is confined to `Read,Write,Edit` with no bash/network, but environment isolation is the
> primary defense.

## Verification (what a correct build checks)

- The published tree passes `validate_tree` (clean inertness) and serves real bytes on every portal;
  anything absent -> **real 404**.
- The lure works end to end: `GET /ops` without a token -> **401**; `GET /.env` leaks the token ->
  `GET /ops` with `Authorization: Bearer <token>` -> **200** + `credential_reuse`.
- Zero external references; health/status endpoints with `{{moqesh.*}}`.

## Deployment (VPS)

1. Run the build on the server (or upload it) with `MOQESH_WORLD_PATH` pointing at the persistent volume.
2. Restart the honeypot container to reload the World.
3. The lure pack is already imported and active in the DB.

## Files

```
moqesh/worldsmith/
  validate.py   inertness safety net (path + content + manifest + tree)
  tools.py      BuildSandbox: bulletproof tools (write_file/set_manifest/plant_bait...)
  providers.py  stub | api (Anthropic tool use) | claude_cli + safe dispatch
  prompt.py     prompt engineering (system + brief) with the hunting-path doctrine
  builder.py    orchestrates, re-validates the tree, publishes atomically + imports the lure
  main.py       CLI: python -m moqesh.worldsmith build|evolve
```
