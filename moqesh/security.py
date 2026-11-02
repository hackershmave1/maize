"""Security of the sensor <-> server channel.

Symmetric per-sensor authentication: the same key (`api_secret`) signs in BOTH
directions (node requests and control responses), so a MITM without the key
can forge neither a delivery nor a "disable". Plus: an anti-replay window, rate limiting
and in-memory dedup. All ingestion is treated as HOSTILE.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from collections import OrderedDict

CLOCK_SKEW_SECONDS = 300  # anti-replay window (and clock tolerance)


def new_credentials() -> tuple[str, str]:
    """Return (key_id, secret). The secret is shown only once."""
    return "mq_" + secrets.token_hex(8), secrets.token_urlsafe(32)


def sign(secret: str, timestamp: str, body: bytes) -> str:
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    return "sha256=" + mac.hexdigest()


def verify(secret: str, timestamp: str, signature: str, body: bytes, now: float | None = None) -> bool:
    now = now if now is not None else time.time()
    try:
        ts = float(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(now - ts) > CLOCK_SKEW_SECONDS:
        return False
    return hmac.compare_digest(sign(secret, timestamp, body), signature or "")


class RateLimiter:
    """In-memory token bucket per key (e.g. key_id)."""

    def __init__(self, per_minute: int = 600, burst: int = 300) -> None:
        self._rate = per_minute / 60.0
        self._burst = float(burst)
        self._state: dict[str, tuple[float, float]] = {}

    def allow(self, key: str, cost: float = 1.0) -> bool:
        now = time.monotonic()
        tokens, last = self._state.get(key, (self._burst, now))
        tokens = min(self._burst, tokens + (now - last) * self._rate)
        if tokens < cost:
            self._state[key] = (tokens, now)
            return False
        self._state[key] = (tokens - cost, now)
        return True


class DedupCache:
    """LRU of seen hashes, to discard repeated events/lines."""

    def __init__(self, maxsize: int = 50_000) -> None:
        self._maxsize = maxsize
        self._seen: OrderedDict[str, None] = OrderedDict()

    def seen(self, key: str) -> bool:
        if key in self._seen:
            self._seen.move_to_end(key)
            return True
        self._seen[key] = None
        if len(self._seen) > self._maxsize:
            self._seen.popitem(last=False)
        return False


def event_hash(sensor_id: int, raw: str) -> str:
    return hashlib.sha256(f"{sensor_id}:{raw}".encode()).hexdigest()


# Process singletons (a single Moqesh server).
ingest_limiter = RateLimiter()
dedup = DedupCache()
