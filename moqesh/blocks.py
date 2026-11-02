"""Closing the response loop: when an attacker is confirmed (reuse of a
planted credential or a score above threshold) their IP is recorded as blocked and
an external system (firewall/Caddy/Slack) is notified via webhook.

Behavioral reference: `Moqesh.Alerts.BlockService` (C#). Here it is
implemented in idiomatic Python: a synchronous data layer (SQLAlchemy `Session`,
like the rest of the project) and an async webhook with `httpx.AsyncClient`.

OS-level blocking (iptables) is OPTIONAL and DISABLED by default:
we run in an unprivileged container, so the real block is at the
application level (the honeypot answers 403 to active IPs) + webhook.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import logging
import os
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import BlockedIp

log = logging.getLogger("moqesh.blocks")


@dataclass(slots=True)
class NotificationOptions:
    """Notification/blocking configuration.

    Equivalent environment variables (see `from_env`):
      - MOQESH_WEBHOOK_URL      -> webhook_url   (empty = no notification)
      - MOQESH_WEBHOOK_SECRET   -> secret        (optional HMAC-SHA256 signature)
      - MOQESH_ENFORCE_BLOCK    -> enforce_block (honeypot responde 403)
      - MOQESH_AUTO_BLOCK_SCORE -> auto_block_score (0 = disabled)
      - MOQESH_ENABLE_IPTABLES  -> enable_iptables (DROP a nivel SO; peligroso)
    """

    # Webhook URL (Slack/Discord/generic). Empty = no notification.
    webhook_url: str = ""
    # Optional secret: adds an X-Moqesh-Signature header with the body's HMAC-SHA256.
    secret: str = ""
    # If True, the honeypot enforces the block (403) on active IPs.
    enforce_block: bool = True
    # Score-based auto-block (0.0 = disabled; e.g. 0.8 = block above threshold).
    auto_block_score: float = 0.0
    # OS-level blocking via iptables. DISABLED by default (requires privileges).
    enable_iptables: bool = False

    @classmethod
    def from_env(cls) -> NotificationOptions:
        """Build the options from environment variables."""
        return cls(
            webhook_url=os.environ.get("MOQESH_WEBHOOK_URL", ""),
            secret=os.environ.get("MOQESH_WEBHOOK_SECRET", ""),
            enforce_block=_env_bool("MOQESH_ENFORCE_BLOCK", True),
            auto_block_score=_env_float("MOQESH_AUTO_BLOCK_SCORE", 0.0),
            enable_iptables=_env_bool("MOQESH_ENABLE_IPTABLES", False),
        )


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class BlockService:
    """Records blocked IPs and fires notifications. Idempotent per IP."""

    def __init__(self, options: NotificationOptions, http: httpx.AsyncClient | None = None) -> None:
        self.options = options
        # If we were not given a client we create one (and close it in aclose).
        self._http = http or httpx.AsyncClient(timeout=5.0)
        self._owns_http = http is None

    async def aclose(self) -> None:
        """Close the httpx client only if we created it."""
        if self._owns_http:
            await self._http.aclose()

    # --- Public API -------------------------------------------------------

    async def block(
        self,
        db: Session,
        ip: str,
        reason: str,
        session_id: int | None = None,
        source: str = "auto",
        meta: dict | None = None,
    ) -> None:
        """Create (if missing) an active block for `ip` and notify.

        Idempotent: if the IP already has an active block, it is not duplicated.
        A webhook failure degrades gracefully (logged, does not break the block).
        """
        ip = (ip or "").strip()
        if not ip or ip == "unknown":
            return  # nothing to block

        if self._active_block(db, ip) is not None:
            return  # already blocked -> idempotent

        db.add(BlockedIp(ip=ip, reason=reason, source=source, session_id=session_id, active=True))
        db.commit()
        log.warning("[block] IP %s blocked (%s): %s", ip, source, reason)

        # Optional OS-level block (no-op unless enable_iptables=True).
        self._iptables_drop(ip)

        await self._notify(
            {
                "event": "attacker_blocked",
                "ip": ip,
                "reason": reason,
                "source": source,
                "session_id": session_id,
                "meta": meta,
                "timestamp": datetime.now(UTC).isoformat(),
            }
        )

    def is_blocked(self, db: Session, ip: str) -> bool:
        """True if the IP has an active block."""
        ip = (ip or "").strip()
        if not ip:
            return False
        return self._active_block(db, ip) is not None

    def unblock(self, db: Session, block_id: int) -> None:
        """Mark the block as inactive (active=False)."""
        row = db.get(BlockedIp, block_id)
        if row is None or not row.active:
            return
        row.active = False
        db.commit()
        log.info("[block] block #%s (%s) lifted", block_id, row.ip)

    # --- Internos --------------------------------------------------------

    def _active_block(self, db: Session, ip: str) -> BlockedIp | None:
        """Return the active block for the IP, or None."""
        return db.scalar(
            select(BlockedIp).where(BlockedIp.ip == ip, BlockedIp.active == True).limit(1)  # noqa: E712
        )

    async def _notify(self, payload: dict) -> None:
        """Send the webhook; any failure is logged but not propagated."""
        if not self.options.webhook_url.strip():
            return
        try:
            # We serialize ourselves so we sign exactly the body that is sent.
            body = json.dumps(payload).encode("utf-8")
            headers = {"Content-Type": "application/json"}
            if self.options.secret:
                sig = hmac.new(self.options.secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
                headers["X-Moqesh-Signature"] = f"sha256={sig}"
            resp = await self._http.post(self.options.webhook_url, content=body, headers=headers)
            log.info("[block] webhook -> %s", resp.status_code)
        except Exception as ex:  # graceful degradation: never breaks the block
            log.warning("[block] webhook failed: %s", ex)

    def _iptables_drop(self, ip: str) -> None:
        """Optional OS-level block. No-op (+ log) unless enable_iptables=True.

        Validates that `ip` is a real IP address before invoking subprocess
        (defense in depth; we also pass args as a list, no shell).
        """
        if not self.options.enable_iptables:
            log.debug("[block] iptables disabled; skipping DROP for %s", ip)
            return
        try:
            ipaddress.ip_address(ip)  # ValueError if not a valid IPv4/IPv6
        except ValueError:
            log.warning("[block] invalid IP, not applying iptables: %r", ip)
            return
        try:
            subprocess.run(
                ["iptables", "-A", "INPUT", "-s", ip, "-j", "DROP"],
                check=True,
                capture_output=True,
                timeout=5,
            )
            log.warning("[block] iptables DROP applied to %s", ip)
        except Exception as ex:  # no privileges/binary: degrade, do not break
            log.warning("[block] iptables failed for %s: %s", ip, ex)
