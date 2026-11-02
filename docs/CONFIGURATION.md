# Configuration

All configuration is read from the environment with the `MOQESH_` prefix (or from a
`.env` file in the working directory). Template: [`.env.example`](../.env.example).

## Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `MOQESH_DB_PATH` | `moqesh.db` | SQLite path. In Docker: `/app/data/moqesh.db`. |
| `MOQESH_WEB_DIST` | *(auto)* | Path to the frontend build. Auto if it sits next to the package (`web/dist`). |

## Network

| Variable | Default | Description |
|----------|---------|-------------|
| `MOQESH_HONEYPOT_PORT` | `8080` | Honeypot port (the labyrinth served to agents). |
| `MOQESH_DASHBOARD_PORT` | `5000` | Port for the dashboard + API + WebSocket + ingestion. |
| `MOQESH_PUBLIC_URL` | *(empty)* | Public URL of the server that remote sensors connect to. Required for sensor onboarding. |

## Content generation

| Variable | Default | Description |
|----------|---------|-------------|
| `MOQESH_SEED` | *(auto)* | Deployment seed. Empty = one is generated (anti-fingerprint). |
| `MOQESH_GENERATION_MODE` | `Template` | `Template` \| `Mimic` \| `Static`. |
| `MOQESH_TARGET_URL` | *(empty)* | Real site to mimic (`Mimic` only). |
| `MOQESH_SITE_PROFILE` | *(empty)* | Built-in profile (`saas`\|`corp`\|`ecommerce`\|`nonprofit`): realistic paths, vocabulary and API collections without crawling. Empty = generic by seed. In `Mimic`, the `TARGET_URL` crawl wins. Generate more with `scripts/build_profile.py`. |
| `MOQESH_REALISM_LEVEL` | `3` | 1 (little lure) .. 5 (dense lure). |
| `MOQESH_VOCABULARY_THEME` | *(auto)* | `corporate` \| `devops` \| `saas` \| `ecommerce`. Empty = by seed. |
| `MOQESH_BRAND_NAME` | *(auto)* | Fictional brand. Empty = derived from the seed. |
| `MOQESH_TARPIT_DELAY_MS` | `0` | Fixed base delay per response (ms). Added to the adaptive tarpit. |
| `MOQESH_ADAPTIVE_TARPIT` | `true` | Delay that grows with session intensity (coherent -> lure). 0 at intensity 0 (human/unknown); it only rises with a confirmed agent. |
| `MOQESH_TARPIT_MAX_MS` | `6000` | Max delay per response at intensity 3 (confirmed agent). |
| `MOQESH_ALLOW_INFINITE_ON_CONFIRMED` | `false` | Brute-burn opt-in: at max intensity the API paginates endlessly again. Breaks the coherence invariant (it becomes fingerprintable again), so it is OFF by default. |
| `MOQESH_SERVER_BANNER` | `nginx` | `Server` banner. `nginx` = derived from the seed. |
| `MOQESH_TOKEN_EXHAUST_ENABLED` | `true` | Enables the Token Exhaust labyrinth (finite and coherent; **legacy**: effectively OFF when a World is active). |
| `MOQESH_WORLD_ENABLED` | `true` | Serves the **World**: multi-site INERT static content (real files on disk; only bytes, never executed). The primary source; replaces the generated labyrinth. |
| `MOQESH_WORLD_PATH` | *(auto)* | World path. Empty = `<DB dir>/world` (persistent volume). |
| `MOQESH_WORLD_AUTOSEED` | `true` | If the World is empty, copy the packaged curated portal seed. |
| `MOQESH_SCENARIOS_ENABLED` | `false` | Serves the active scenario (credential-reuse gate, resolved BEFORE the World). `false` = no active lure (only the World/labyrinth). `true` = active lure. Built-in packs: `realistic-ops` (recommended with a World: **one** leaked `.env.bak` -> hidden ops console with mock data, nothing that looks like a CTF), `corp-breach`/`git-leak` (CTF-style chains). Enable it with `POST /api/scenarios/builtins/realistic-ops?activate=true`. |

### World: manifest and voluminous content (genbig)

The World's `manifest.json` mounts portals: `{"mounts": [{"prefix", "dir", "spa", "autoindex"}]}`.
- **`autoindex: true`** -> a directory **without `index.html`** serves a **server-style listing**
  (an "open directory" decoy) instead of a 404. Default `false` (a dir without an index = 404).
- Static files **> 1 MiB are streamed** (real Content-Length/Range, without
  reading them into memory): you can serve heavy trees without exhausting the honeypot's RAM.

To fill a voluminous tree with **REAL text** (finite token burn, without the giveaway of
generated/templated content) use [`scripts/genbig.py`](../scripts/genbig.py):

```bash
# /data with 50 files of 10 MiB (public-domain text, cached in ~/.cache/genbig)
python3 scripts/genbig.py <world>/sites/data --files 50 --size 10M --lang en
# numeric subdirs: /files/2023 /files/2024 /files/2025
python3 scripts/genbig.py <world>/sites/files --files 60 --size 10M \
    --subdirs 3 --subdir-prefix "" --subdir-width 4 --subdir-start 2023
```

Then add the mount with `autoindex` to the World's `manifest.json` and restart the honeypot:

```json
{ "prefix": "/data", "dir": "sites/data", "autoindex": true }
```

genbig's output is NOT committed: it lives in the World volume (`<DB dir>/world`).

## Detection and alerts

| Variable | Default | Description |
|----------|---------|-------------|
| `MOQESH_ALERT_SCORE_THRESHOLD` | `0.5` | Minimum score to alert. |
| `MOQESH_ALERT_MIN_REQUESTS` | `5` | Minimum requests in the session to alert. |

## Blocking and notifications

| Variable | Default | Description |
|----------|---------|-------------|
| `MOQESH_ENFORCE_BLOCK` | `true` | The honeypot answers 403 to blocked IPs. |
| `MOQESH_AUTO_BLOCK_SCORE` | `0.0` | Score-based auto-block (0 = disabled; `credential_reuse` always blocks). |
| `MOQESH_WEBHOOK_URL` | *(empty)* | Notification webhook (HMAC-signed via `X-Moqesh-Signature`). |
| `MOQESH_WEBHOOK_SECRET` | *(empty)* | Secret for signing the webhook. |
| `MOQESH_ENABLE_IPTABLES` | `false` | Optional OS-level blocking (OFF by default). |

## Dashboard authentication (single admin)

The dashboard/API (`/api/*`) sits behind a signed cookie session. The sensor channel
(`/ingest/*`, `/control`, `/s/*`, `/download/*`, `/healthz`) is NOT affected:
it keeps its own HMAC authentication.

| Variable | Default | Description |
|----------|---------|-------------|
| `MOQESH_ADMIN_USER` | `admin` | Admin user created on first startup. |
| `MOQESH_ADMIN_PASSWORD` | *(empty)* | Admin password. Empty = one is generated and printed to the log **once**. |
| `MOQESH_SESSION_SECRET` | *(empty)* | Cookie signing secret. Empty = generated and persisted next to the DB (stable per deployment). |
| `MOQESH_SESSION_MAX_AGE` | `86400` | Session lifetime in seconds. |
| `MOQESH_COOKIE_SECURE` | `false` | `true` behind TLS (admin subdomain); `false` locally/over an http tunnel. |

Exposure: the dashboard is published on its own TLS subdomain (e.g.
`moqesh-admin.…`) behind the shared Caddy (see [`deploy/caddy-admin.snippet`](../deploy/caddy-admin.snippet))
and also stays reachable over an SSH tunnel. A surface separate from the public honeypot.

## AI confirmation (optional)

The system works without this module (heuristic mode).

| Variable | Default | Description |
|----------|---------|-------------|
| `MOQESH_AI_ENABLED` | `false` | Enables gray-zone confirmation. |
| `MOQESH_AI_PROVIDER` | `heuristic` | `heuristic` \| `openai` (OpenAI-compatible endpoint). |
| `MOQESH_AI_BASE_URL` | *(empty)* | E.g. `https://openrouter.ai/api/v1`. |
| `MOQESH_AI_API_KEY` | *(empty)* | Provider key. |
| `MOQESH_AI_MODEL` | *(empty)* | E.g. `anthropic/claude-haiku-5.5`. |
| `MOQESH_AI_GRAY_ZONE_LOW` / `_HIGH` | `0.35` / `0.65` | Score range that triggers confirmation. |
| `MOQESH_AI_CONFIRM_THRESHOLD` | `0.7` | Minimum confidence to set a verdict. |

## Worldsmith (AI World builder)

An AI agent that builds/evolves the World's inert content + the lure. It is invoked on
demand (`python -m moqesh.worldsmith build|evolve`), not per request. Guide:
[`docs/WORLDSMITH.md`](WORLDSMITH.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `MOQESH_WORLDSMITH_PROVIDER` | `stub` | `stub` (deterministic, no AI) \| `api` (Anthropic tool use) \| `claude_cli` (subscription CLI). |
| `MOQESH_WORLDSMITH_MODEL` | *(empty)* | Provider model (e.g. `claude-sonnet-4-5` for `api`; a CLI alias). |
| `MOQESH_WORLDSMITH_API_KEY` | *(empty)* | Key for `provider=api`. If empty, falls back to `MOQESH_AI_API_KEY`. |
| `MOQESH_WORLDSMITH_BASE_URL` | `https://api.anthropic.com` | Messages API endpoint (`api`). |
| `MOQESH_WORLDSMITH_PORTALS` | `4` | Approximate number of portals to generate. |
| `MOQESH_WORLDSMITH_BRAND` | *(empty)* | Site brand/identity. Empty = the agent derives it from the brief. |

For `claude_cli`, authentication comes from the CLI or from `CLAUDE_CODE_OAUTH_TOKEN` (from
`claude setup-token`), inherited by the subprocess. The provider is confined to `Read,Write,Edit`
with no bash or network.

## Remote sensors (on the customer's server)

These variables are consumed by the **agent** or the **agentless shipper**, not the central server:
`MOQESH_SERVER`, `MOQESH_KEY_ID`, `MOQESH_SECRET`, and (agent) `MOQESH_AGENT_PORT`,
`MOQESH_CONTROL_INTERVAL`, `MOQESH_BEACON_JITTER`; (shipper) `MOQESH_LOG`, `MOQESH_BASE_PATH`,
`MOQESH_FORMAT`, `MOQESH_STATE`, `MOQESH_DRY_RUN`. Details in
[`moqesh/agent/BUILD.md`](../moqesh/agent/BUILD.md) and [`moqesh/clients/README.md`](../moqesh/clients/README.md).
