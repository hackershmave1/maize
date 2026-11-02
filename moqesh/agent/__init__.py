"""Moqesh remote agent.

Autonomous honeypot that runs at the edge (customer servers). Packaged as a
self-contained PyInstaller binary (see BUILD.md): it does NOT depend on the DB, FastAPI,
SQLAlchemy or pydantic-settings; only the stdlib + httpx + the pure labyrinth,
scenario and security modules.
"""

from __future__ import annotations

from .main import AgentConfig, build_event, build_scenario, progress_facts, update_progress

AGENT_VERSION = "0.1.0"

__all__ = [
    "AGENT_VERSION",
    "AgentConfig",
    "build_event",
    "build_scenario",
    "progress_facts",
    "update_progress",
]
