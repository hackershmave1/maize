"""Real time over native WebSocket (replacing SignalR).

A single `ConnectionManager` shared in the process: the dashboard registers the
browsers' WebSockets and the honeypot publishes events (`request`, `alert`).
Since the honeypot runs in the threadpool (sync endpoints), it publishes in a
thread-safe way by scheduling the send on the already captured event loop.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import WebSocket

logger = logging.getLogger("moqesh.realtime")


class ConnectionManager:
    def __init__(self) -> None:
        self._active: set[WebSocket] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._active.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._active.discard(ws)

    async def _send_all(self, msg: str) -> None:
        for ws in list(self._active):
            try:
                await ws.send_text(msg)
            except Exception:
                self._active.discard(ws)

    async def apublish(self, event: str, data: dict) -> None:
        """Publish from an async context (e.g. the dashboard itself)."""
        if self._active:
            await self._send_all(json.dumps({"event": event, "data": data}, default=str))

    def publish(self, event: str, data: dict) -> None:
        """Publish from a sync context/another thread (the honeypot). Fire-and-forget."""
        if not self._active or self._loop is None:
            return
        msg = json.dumps({"event": event, "data": data}, default=str)
        try:
            asyncio.run_coroutine_threadsafe(self._send_all(msg), self._loop)
        except Exception:
            pass

    def schedule(self, coro) -> None:
        """Schedule a coroutine (webhook, AI confirmation) on the event loop, without waiting."""
        if self._loop is not None:
            try:
                asyncio.run_coroutine_threadsafe(coro, self._loop)
                return
            except Exception:
                pass
        try:
            asyncio.run(coro)
        except Exception:
            logger.debug("Could not schedule the coroutine in the background", exc_info=True)


manager = ConnectionManager()
