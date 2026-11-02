# Moqesh AI

<!-- Replace `juliourena/moqesh` with the repo's real GitHub slug (badge + GHCR, below). -->
![CI](https://github.com/juliourena/moqesh/actions/workflows/ci.yml/badge.svg)

An open-source honeypot against **autonomous AI agents** that scan your
infrastructure. Moqesh serves a **Token Exhaust labyrinth** — an infinite,
coherent maze of believable content — that traps automated agents, **drains
their LLM's tokens**, profiles their behavior, and lets you detect and
block them. A native **Python** project (FastAPI + SQLAlchemy).

**Documentation:** [configuration](docs/CONFIGURATION.md) · [worldsmith (AI builder)](docs/WORLDSMITH.md)
· [remote sensors](docs/SENSORS.md) · [contributing](CONTRIBUTING.md) · [security](SECURITY.md)

## How it works

1. **Lure** — serves a fake internal portal: directory listings, `.env` files,
   configs, READMEs, APIs, and decoy binaries.
2. **Trap** — every page links deeper: listings never end, APIs paginate
   forever, READMEs point to "juicy" files, and JS bundles hide endpoints. An
   agent that *follows everything* navigates indefinitely.
3. **Detect** — every request is scored by a **behavioral rules** engine
   (timing regularity, depth descent, exhaustive fan-out, breadcrumb/README
   following, JS deobfuscation, AI-crawler UAs…). Crossing the threshold raises an alert.
4. **Confirm (optional)** — an LLM module reviews gray-zone sessions and
   confirms whether the visitor is an agent. The system works **without** this module.
5. **Block** — reuse of a planted credential (honeytoken) or a score above the
   threshold actively blocks the IP (403) and can notify via webhook.

All content is **deterministic per `(seed, path)`**: the same URL always returns
the same page within a deployment (no telltale random noise), while two
deployments with different seeds share no static signature (anti-fingerprint).

## Generation modes

- **Template** — generic vocabulary mutated by seed (zero-config, works against any target).
- **Mimic** — profiles a real site (`TargetUrl`, read-only crawl) and generates content that blends in with it.
- **Static** — disables the procedural labyrinth.

## CTF scenarios

On top of the labyrinth you can enable an authorable **scenario**: an attack
chain with hidden routes, real credential gates, decompilable binaries, and
vaults. Two packs are included: `corp-breach` (DLL → vault → credential reuse →
flag) and `git-leak` (`.git` leak → token → CI secrets). Editable and
importable/exportable as JSON from the dashboard.

## World and Worldsmith (inert content + AI)

The primary content source is the **World**: a tree of real, **inert** files
(several portals under different prefixes, with mock data) that the honeypot serves **only as
bytes — it never executes anything**. It replaces the generated labyrinth (which becomes *legacy*,
OFF when a World is present) and removes the structural artifacts that gave the honeypot away.

For **large-scale token burning without the giveaway of generated content**, a World
directory can be marked `"autoindex": true` (it serves an "open directory" listing) and filled
with voluminous trees of **real text** using [`scripts/genbig.py`](scripts/genbig.py);
large files are streamed. Details in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

The **worldsmith** is an AI agent that **builds and evolves** that World plus a **lure**
placed on the attacker's hunting path (a leaked `.env` with a single honeytoken → a
protected ops console; reusing the token fires `credential_reuse` and blocks). Inertness is
**enforced mechanically** (per-write validation + re-validation of the tree before publishing),
not entrusted to the prompt. Providers: `stub` (no AI), `api` (Anthropic tool use), and `claude_cli`
(subscription). Usage:

```bash
python -m moqesh.worldsmith build --provider claude_cli --brand "Harborline" --profile saas
```

Full guide: [`docs/WORLDSMITH.md`](docs/WORLDSMITH.md).

## Quick start

### Docker

```bash
docker compose up --build
```

Dashboard: http://localhost:5000 · Honeypot: http://localhost:8080

### Development

```bash
# Backend (honeypot + dashboard/API in one process)
uv venv .venv && uv pip install --python .venv -e .
.venv/bin/moqesh            # or: .venv/bin/python -m moqesh.main

# Frontend (hot reload, proxies to :5000)
cd web && npm install && npm run dev
```

Configuration via environment (`MOQESH_` prefix): see [`.env.example`](.env.example).

## Sensors (remote deployment)

Moqesh can protect servers it does **not** live on, via *sensors*:

- **Agent** — a self-contained binary that runs the full engine on the remote
  server (infinite labyrinth, credential/CTF gates) and sends signed telemetry.
- **Agentless** — static ZIPs (randomized, patternless) that you unzip wherever
  you like + a scheduled task that ships the logs; no software to install.

One-command enrollment from the dashboard (with live connection verification),
hot control and key rotation, HMAC-signed auth in both directions.
Full guide: [`docs/SENSORS.md`](docs/SENSORS.md).

## Architecture

```
moqesh/
  rng.py          deterministic RNG per (seed,path) — anti-fingerprint primitive
  vocabulary.py   vocabulary pools by theme
  labyrinth.py    Token Exhaust generator (legacy: OFF when a World is active)
  world.py        inert World: serves ONLY bytes of real multi-portal files (primary source)
  worlds/         curated seed of inert portals + manifest
  worldsmith/     AI agent that builds/evolves the World + the lure (validated inertness)
  detection.py    behavioral scoring engine (10 rules + scenario signals)
  scenarios.py    CTF engine + built-in packs (import/export)
  forge.py        decoy binaries (patched DLL template; PE fallback)
  mimic.py        real-site profiler (Mimic mode)
  ai_analyst.py   optional confirmation (heuristic or OpenAI-compatible LLM)
  blocks.py       active IP blocking + webhooks
  models.py       SQLAlchemy models (SQLite)
  schemas.py      Pydantic contract (camelCase) for the frontend
  realtime.py     native WebSocket (real time to the dashboard)
  pipeline.py     central scoring (shared by the local honeypot and remote ingestion)
  security.py     bidirectional HMAC, anti-replay, rate limiting, dedup
  provisioning.py install scripts/instructions (1-command onboarding)
  logparse.py     agentless log parser (nginx/apache/caddy/json)
  bundles.py      random static ZIP generator (agentless mode)
  honeypot.py     local trap server (:8080) — the `local` sensor
  agent/          self-contained remote agent (PyInstaller binary)
  clients/        agentless shipping script (sh + PowerShell)
  api/            dashboard + REST API + sensor ingestion/control (:5000)
web/              React + TypeScript dashboard (Vite, Tailwind)
```

**Decisions**: synchronous SQLAlchemy (FastAPI threadpool) for SQLite; async `httpx`
only for outbound HTTP (mimic, LLM, webhooks); real time via native
WebSocket. The forge uses a DLL template generated offline (see
[`tools/build_template_dll.md`](tools/build_template_dll.md)); without it, it degrades to
a binary with embedded credentials.

## Tests and CI

```bash
.venv/bin/python -m pytest -q         # determinism, scenarios, sensors, and integration
.venv/bin/ruff check moqesh tests     # lint
```

CI (`.github/workflows/ci.yml`) runs lint + tests + the SPA build on every push/PR.

## Builds and releases

When a `vX.Y.Z` tag is published, `.github/workflows/release.yml`:

- Builds the **agent binaries** (PyInstaller) for `linux/amd64`, `linux/arm64`, and
  `windows/amd64` and attaches them to the **GitHub Release**. The server serves them at
  `GET /download/agent/{os-arch}`. Build recipe: [`moqesh/agent/BUILD.md`](moqesh/agent/BUILD.md).
- Publishes the **multi-arch Docker image** (amd64/arm64) to **GHCR**
  (`ghcr.io/juliourena/moqesh:<tag>` and `:latest`), with the linux agent binaries embedded.

```bash
# Run the published image:
docker run -p 5000:5000 -p 8080:8080 -v moqesh-data:/app/data ghcr.io/juliourena/moqesh:latest
```

Contributing: see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

**AGPL-3.0-or-later** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). © 2026 Julio Ureña.

Strong copyleft with a network clause: you may use, modify, and offer Moqesh (even
commercially), but if you distribute a modified version **or offer it as a network
service**, you must publish its source code under AGPL-3.0 and retain attribution. For
proprietary/closed-source use without those obligations, get in touch about a commercial license (dual licensing).
