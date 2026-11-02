# Contributing to Moqesh AI

Thanks for your interest. This guide covers the development environment, testing and
the project's conventions.

## Requirements

- Python 3.12+ and [uv](https://docs.astral.sh/uv/)
- Node 20+ (for the React dashboard)

## Getting started

```bash
# Backend
uv venv .venv
uv pip install --python .venv -e . pytest ruff
.venv/bin/moqesh                 # honeypot :8080 + dashboard/API :5000

# Frontend (hot reload, proxies to :5000)
cd web && npm install && npm run dev
```

Configuration via environment (`MOQESH_` prefix): see [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)
and [`.env.example`](.env.example).

## Tests and lint

```bash
.venv/bin/python -m pytest -q      # full suite
.venv/bin/ruff check moqesh tests  # lint
.venv/bin/ruff format moqesh tests # formatting
cd web && npm run build            # type-check + SPA build
```

CI (`.github/workflows/ci.yml`) runs exactly this on every push/PR.

## Agent binaries

The remote agent ships as a self-contained binary (PyInstaller). The per-platform
recipe is in [`moqesh/agent/BUILD.md`](moqesh/agent/BUILD.md); the `release.yml`
workflow builds them (linux amd64/arm64 + windows) when a `vX.Y.Z` tag is published.

## Structure

See the tree in the [README](README.md#architecture). In short: `moqesh/` is the
backend (engine + API + sensor ingestion), `web/` the dashboard, `docs/` the guides.

- The **engine** (`labyrinth`, `scenarios`, `detection`, `rng`) is pure and deterministic.
- **Detection is central**: `pipeline.py` is shared by the local honeypot and remote
  ingestion. Add rules there, not in two places.
- The **frontend contract** comes from `schemas.py` (Pydantic, camelCase); do not build
  JSON by hand in the routers.

## Conventions

- Code, comments and docs in English; `ruff` must pass cleanly.
- **Synchronous** SQLAlchemy (FastAPI threadpool); **async** `httpx` only for outbound HTTP.
- Add tests for new logic; the tests isolate the DB via `tests/conftest.py`.
- Commit convention: a one-line summary + a body explaining the why.

## Security

Found a vulnerability? Do not open a public issue: see [`SECURITY.md`](SECURITY.md).
