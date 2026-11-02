"""Server-side generation of install scripts and instructions.

Everything the user pastes on their server comes from here, with the key and URL already
embedded. Onboarding is: create sensor -> copy one command -> connected.
"""

from __future__ import annotations

from .config import settings


def server_url() -> str:
    return (settings.public_url or f"http://localhost:{settings.dashboard_port}").rstrip("/")


def one_command(token: str) -> str:
    """Main command (curl | sh) for the wizard."""
    return f"curl -fsSL {server_url()}/s/{token} | sh"


def inspect_command(token: str) -> str:
    """'Inspect first' alternative: download + check the checksum before running."""
    url = f"{server_url()}/s/{token}"
    return (
        f"curl -fsSL {url} -o moqesh-install.sh && sha256sum moqesh-install.sh "
        "&& less moqesh-install.sh && sh moqesh-install.sh"
    )


def agent_install_script(key_id: str, secret: str) -> str:
    """POSIX script that installs the agent as a self-contained binary + service."""
    srv = server_url()
    return f"""#!/bin/sh
set -eu
# Moqesh agent installer. Review this script before running it.
SERVER="{srv}"
KEY_ID="{key_id}"
SECRET="{secret}"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "arquitectura no soportada: $ARCH"; exit 1 ;;
esac

DIR="${{MOQESH_DIR:-/opt/moqesh}}"
mkdir -p "$DIR"
echo "[moqesh] preflight: probando conectividad a $SERVER ..."
if ! curl -fsS -o /dev/null "$SERVER/healthz"; then
  echo "[moqesh] ERROR: cannot reach $SERVER. Open HTTPS egress to that host."; exit 1
fi
echo "[moqesh] downloading agent ($OS/$ARCH) ..."
curl -fsSL "$SERVER/download/agent/$OS-$ARCH" -o "$DIR/moqesh-agent"
chmod +x "$DIR/moqesh-agent"
cat > "$DIR/agent.env" <<EOF
MOQESH_SERVER=$SERVER
MOQESH_KEY_ID=$KEY_ID
MOQESH_SECRET=$SECRET
EOF
chmod 600 "$DIR/agent.env"

if command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/moqesh-agent.service <<EOF
[Unit]
Description=Moqesh Agent
After=network.target
[Service]
EnvironmentFile=$DIR/agent.env
ExecStart=$DIR/moqesh-agent
Restart=always
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable --now moqesh-agent
  echo "[moqesh] agent installed and started (systemd service)."
else
  echo "[moqesh] no systemd; start it manually: env \\$(cat $DIR/agent.env) $DIR/moqesh-agent &"
fi
"""


def agentless_steps(sensor_id: int, key_id: str, secret: str, base_path: str, bundle_count: int) -> dict:
    """Steps and snippets for the no-install mode (ZIP + cron)."""
    srv = server_url()
    cron = (
        f"*/5 * * * * MOQESH_SERVER={srv} MOQESH_KEY_ID={key_id} MOQESH_SECRET={secret} "
        f"/opt/moqesh/moqesh-ship.sh >/dev/null 2>&1"
    )
    return {
        "steps": [
            f"Download the shipping script: curl -fsSL {srv}/download/shipper/{sensor_id} "
            "-o /opt/moqesh/moqesh-ship.sh && chmod +x /opt/moqesh/moqesh-ship.sh",
            f"Download and unpack the {bundle_count} bundles wherever you want to serve the lure "
            f"(under {base_path}). Links are in the sensor's tab.",
            "Apply the safe-serving config (plain text, no execution) we provide per web server type.",
            "Add the scheduled task (cron) below to ship the lure's logs.",
        ],
        "cron": cron,
        "shipper_url": f"{srv}/download/shipper/{sensor_id}",
        "note": "The script only ships log lines matching the lure prefix; do a dry run first.",
    }
