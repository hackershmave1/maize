"""Built-in site profiles, selectable per deployment.

A profile is a JSON dict (same contract as the Mimic profile from `mimic.py`, plus
`theme` and `api_resources`) that gives the labyrinth a realistic route taxonomy, vocabulary and
API collections WITHOUT crawling anything. The generator consumes it via
`LabyrinthOptions.profile`. Selectable with `MOQESH_SITE_PROFILE=<name>`.

Contract (all optional; the generator degrades gracefully if missing):
    {
      "theme":          "saas|corporate|devops|ecommerce",  # base vocabulary theme
      "server_banner":  "cloudflare",                       # Server header
      "vocabulary":     [...],   # domain words -> directory names
      "paths":          [...],   # observed paths ("/console/", "/billing/")
      "api_prefixes":   [...],   # API prefixes ("/api/v2")
      "api_resources":  [...],   # API collections that EXIST ("tenant", "invoice")
    }
"""

from __future__ import annotations

import json
from pathlib import Path

_DIR = Path(__file__).parent


def available() -> list[str]:
    """Names of available built-in profiles (e.g. ['corp', 'ecommerce', 'nonprofit', 'saas'])."""
    return sorted(p.stem for p in _DIR.glob("*.json"))


def load_builtin(name: str) -> dict | None:
    """Load a built-in profile by name; None if it does not exist or is corrupt.

    Only accepts simple file names (no path separators): the name comes from
    operator configuration, but validating it prevents any directory escape.
    """
    if not name or "/" in name or "\\" in name or name.startswith("."):
        return None
    path = _DIR / f"{name}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None
