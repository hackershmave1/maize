"""Entrypoint: starts the honeypot (:8080) and dashboard+API (:5000) in one process.

Both ASGI apps run on the same asyncio event loop (one per `uvicorn.Server`).
"""

from __future__ import annotations

import asyncio

import uvicorn

from .api import app as api_app
from .config import settings
from .honeypot import app as honeypot_app


async def _serve() -> None:
    # server_header=False: uvicorn does NOT add its own `Server: uvicorn` header. The honeypot
    # emits exactly ONE `Server` header (its banner), like a real web server; two
    # Server headers (one from the framework, one from the banner) would expose the setup.
    # server_header/date_header=False: uvicorn does NOT add its `Server`/`Date` headers. The
    # honeypot emits them itself, in Title-Case and with a single consistent banner, just like a
    # real web server (nginx/IIS); otherwise it would expose the ASGI stack (lowercase, double Server).
    honeypot = uvicorn.Server(
        uvicorn.Config(
            honeypot_app, host="0.0.0.0", port=settings.honeypot_port,
            log_level="warning", server_header=False, date_header=False,
        )
    )
    dashboard = uvicorn.Server(
        uvicorn.Config(
            api_app, host="0.0.0.0", port=settings.dashboard_port,
            log_level="info", server_header=False, date_header=False,
        )
    )
    print(f"Honeypot  -> http://localhost:{settings.honeypot_port}")
    print(f"Dashboard -> http://localhost:{settings.dashboard_port}  (API at /api, WS at /hubs/stream)")
    await asyncio.gather(honeypot.serve(), dashboard.serve())


def main() -> None:
    asyncio.run(_serve())


if __name__ == "__main__":
    main()
