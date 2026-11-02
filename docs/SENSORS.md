# Sensors: deploying Moqesh on remote servers

A **sensor** is a place where the Moqesh lure is served. There are three types:

| Type | What it is | Capabilities | Footprint on the host |
|------|------------|--------------|-----------------------|
| `local` | Moqesh's own honeypot (:8080) | Everything | None |
| `agent` | Self-contained binary on the remote server | Infinite labyrinth + tarpit + **credential/CTF gates** + telemetry | Process + port + outbound beacon |
| `agentless` | Static ZIP + a cron job that ships logs | **Behavioral detection** (no live gates) | Only files + an occasional cron job (max stealth) |

Rule of thumb: use **agent** when you need CTF/credential reuse; use **agentless** when you cannot (or do not want to) install anything, or when stealth comes first.

## Enrolling a sensor (1 command)

1. Dashboard → **Sensors → Add sensor**. The wizard recommends the mode with 3 questions and creates the sensor.
2. Copy the **one-time command** that appears (it is shown **only once** and carries the embedded key):

   ```sh
   curl -fsSL https://YOUR-MOQESH/s/<token> | sh
   ```

   Prefer to review before running? Use the **inspect** option: download the script, check its `sha256` and read it before running it.
3. The wizard waits on *"waiting for the first check-in..."* and switches to **✓ connected** as soon as the sensor sends a heartbeat (over WebSocket).

### Agent mode

The installer runs a **preflight** (connectivity to Moqesh and the clock), downloads the binary for your `os/arch`, writes the config with the key (permissions `600`) and installs a service (`systemd` on Linux, a service on Windows). From then on the agent serves the lure and sends signed telemetry.

> The agent binaries are produced by CI (`release.yml`, PyInstaller) and attached to the
> GitHub Release; the GHCR Docker image already embeds them (linux amd64/arm64), so
> `GET /download/agent/{os-arch}` works with no extra steps. Manual build: [`moqesh/agent/BUILD.md`](../moqesh/agent/BUILD.md).

### Agentless mode

1. Download the **shipping script** and the **bundles** (several ZIPs, each with a different structure/size, so there are no patterns).
2. Unpack the bundles wherever you want to serve the lure (e.g. under `/lure`).
3. Apply the **safe-serving** snippet (included in each bundle, for nginx/apache/caddy) that serves the content as **plain text, with no execution**.
4. Add the **scheduled task** the wizard gives you (it reads only the lines with the lure prefix and sends them signed):

   ```
   */5 * * * * MOQESH_SERVER=... MOQESH_KEY_ID=... MOQESH_SECRET=... /opt/moqesh/moqesh-ship.sh
   ```

   Do a **dry run** (`MOQESH_DRY_RUN=1`) to see what would be sent before enabling it.

## Security

- Each sensor has its own **symmetric key**; HMAC signing in both directions (sensor deliveries **and** control responses), so a MITM can forge neither a delivery nor a "disable". Timestamp-based anti-replay window.
- **Least-privilege** key (only ingestion + control of its own sensor), **revocable/rotatable** in one click from the dashboard. The key lives on a host that may be attacked: by design it is low value.
- All ingestion is treated as **hostile**: validation, rate limiting, dedup and prefix filtering. Agentless only sends lure lines (not real user traffic).

## Operations

- **Status**: the Sensors page shows online/offline (by last check-in), sessions and alerts per sensor, version and last delivery. A sensor that goes quiet may mean it was found: Moqesh flags it.
- **Enable/disable and rotate the seed**: live; the agent and the cron job poll `/control` and apply it.
- **Decommission**: revokes the key and retires the sensor. In agentless mode, remove the lure with the `uninstall.sh` included in the bundle (it uses `MANIFEST.json`).

## Limits of this release

- Agentless mode detects **behavior**, not credential reuse at live gates (that requires an agent).
- Remote servers must be able to **reach** the Moqesh server (outbound HTTPS). The installer checks connectivity; for environments with closed egress, a store-and-forward relay will come in a future release.
