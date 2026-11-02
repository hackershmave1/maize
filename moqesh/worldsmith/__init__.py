"""Worldsmith: an AI agent that BUILDS and evolves the World's inert content
and the lure pack, with an inertness safety net that is never skipped.

Distinct from `moqesh/agent/` (the remote sensor that reports hits). Here the agent
PRODUCES static files; Moqesh serves them as bytes and never executes them.
"""

from .validate import (
    MAX_BINARY_BYTES,
    MAX_TEXT_BYTES,
    InertnessError,
    validate_file,
    validate_manifest,
    validate_tree,
)

__all__ = [
    "InertnessError",
    "MAX_BINARY_BYTES",
    "MAX_TEXT_BYTES",
    "validate_file",
    "validate_manifest",
    "validate_tree",
]
