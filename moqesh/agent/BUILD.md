# Packaging the Moqesh remote agent

The agent (`moqesh.agent`) ships as a **self-contained binary** (PyInstaller
`--onefile`) so a customer can run it without installing Python or dependencies. It does
not need the DB, FastAPI or pydantic-settings: only the stdlib + `httpx` + the pure modules
`moqesh.labyrinth`, `moqesh.scenarios` and `moqesh.security`.

## Entry point / running

```bash
python -m moqesh.agent        # from the repo (development)
./moqesh-agent-linux-amd64    # packaged binary
```

Environment variables:

| Variable                  | Default | Description                                              |
|---------------------------|---------|----------------------------------------------------------|
| `MOQESH_SERVER`           | (none)  | URL of the central server (required)                     |
| `MOQESH_KEY_ID`           | (none)  | The sensor's key id (required)                           |
| `MOQESH_SECRET`           | (none)  | The sensor's HMAC secret (required)                      |
| `MOQESH_AGENT_PORT`       | `8080`  | Port of the local honeypot                               |
| `MOQESH_CONTROL_INTERVAL` | `30`    | Seconds between control beacons / event deliveries       |
| `MOQESH_BEACON_JITTER`    | `0.3`   | Symmetric jitter (±fraction) on the interval             |

## Build dependency

```bash
.venv/bin/pip install pyinstaller
```

> Note: `moqesh.scenarios` imports SQLAlchemy at module level (it shares dataclasses with
> the server's ORM). PyInstaller detects and includes it; the agent does **not** use it at
> runtime. To slim the binary you can exclude what is not touched (see `--exclude-module`).

## Building per platform

PyInstaller **does not cross-compile**: you have to build on (or emulate) each OS/arch.
The output name must be `moqesh-agent-<os>-<arch>` and it is copied to
`moqesh/agent/dist/`, from where the server serves it at `GET /download/agent/{os-arch}`
(see `moqesh/api/__init__.py::download_agent`).

Common options (include the forge DLL template and trim size):

```
COMMON="--onefile --name moqesh-agent \
  --add-data moqesh/assets/portal_template.dll:moqesh/assets \
  --hidden-import httpx \
  --exclude-module fastapi --exclude-module uvicorn \
  --exclude-module pydantic --exclude-module pydantic_settings \
  moqesh/agent/__main__.py"
```

(On Windows, the `--add-data` separator is `;` instead of `:`. If the DLL template does not
exist, the forge degrades to a decoy PE and the build still works; omit the `--add-data`.)

### linux/amd64

```bash
# On a linux x86_64 machine/container:
pyinstaller $COMMON
mv dist/moqesh-agent moqesh/agent/dist/moqesh-agent-linux-amd64
```

### linux/arm64

```bash
# On a linux aarch64 machine/container (or QEMU: docker run --platform linux/arm64 ...):
pyinstaller $COMMON
mv dist/moqesh-agent moqesh/agent/dist/moqesh-agent-linux-arm64
```

Example with Docker + buildx for arm64:

```bash
docker run --rm --platform linux/arm64 -v "$PWD":/src -w /src python:3.11-slim bash -c "
  pip install -e . pyinstaller &&
  pyinstaller $COMMON &&
  cp dist/moqesh-agent /src/moqesh/agent/dist/moqesh-agent-linux-arm64"
```

### windows/amd64

```powershell
# On Windows x64 (PowerShell). Note the `;` in --add-data:
pyinstaller --onefile --name moqesh-agent `
  --add-data "moqesh/assets/portal_template.dll;moqesh/assets" `
  --hidden-import httpx `
  --exclude-module fastapi --exclude-module uvicorn `
  --exclude-module pydantic --exclude-module pydantic_settings `
  moqesh/agent/__main__.py
move dist\moqesh-agent.exe moqesh\agent\dist\moqesh-agent-windows-amd64
```

## Expected output

```
moqesh/agent/dist/
  moqesh-agent-linux-amd64
  moqesh-agent-linux-arm64
  moqesh-agent-windows-amd64     # (the .exe is renamed without an extension)
```

The server maps `GET /download/agent/{os-arch}` -> `moqesh/agent/dist/moqesh-agent-<os-arch>`
and delivers it with `filename="moqesh-agent"`. If the binary is missing, it returns 404
("build pending"), so these artifacts must be generated and committed (or uploaded
to the CI artifact store) before downloads are published.

## Quick check

```bash
MOQESH_SERVER=http://localhost:5000 MOQESH_KEY_ID=mq_x MOQESH_SECRET=s \
  ./moqesh-agent-linux-amd64   # should preflight /healthz and open port 8080
```
