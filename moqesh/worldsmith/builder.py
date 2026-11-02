"""Worldsmith orchestration: runs a provider in a staging dir, re-validates the ENTIRE tree
(final inertness gate) and, only if clean, atomically publishes to the World and imports the
lure pack. The live World is never touched until the build passes full validation.
"""

from __future__ import annotations

import logging
import os
import shutil

from ..world import SEED_DIR
from .prompt import SYSTEM_PROMPT, build_brief
from .providers import Provider
from .tools import BuildSandbox
from .validate import validate_tree

logger = logging.getLogger("moqesh.worldsmith")


def _publish(staging: str, world_path: str) -> None:
    """Atomic swap: staging (a sibling of world_path) becomes the World; the previous one goes to .prev."""
    world_path = os.path.abspath(world_path)
    prev = world_path + ".prev"
    if os.path.exists(prev):
        shutil.rmtree(prev, ignore_errors=True)
    if os.path.exists(world_path):
        os.replace(world_path, prev)  # atomic on the same FS
    os.replace(staging, world_path)


def build_world(
    *,
    provider: Provider,
    world_path: str,
    brand: str = "",
    profile: str = "",
    goal: str = "",
    portals: int = 4,
    import_bait: bool = True,
    activate: bool = True,
    seed_from_current: bool = False,
) -> dict:
    """Build (or evolve) the World with the given provider and publish it if it validates.

    Returns a report. If final validation fails, it does NOT publish and leaves the live World intact.
    """
    world_path = os.path.abspath(world_path)
    os.makedirs(os.path.dirname(world_path) or ".", exist_ok=True)
    staging = world_path + ".building"
    if os.path.exists(staging):
        shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging, exist_ok=True)

    # Evolution: start from a copy of the current World so the agent modifies it.
    if seed_from_current and os.path.isfile(os.path.join(world_path, "manifest.json")):
        for item in os.listdir(world_path):
            src = os.path.join(world_path, item)
            dst = os.path.join(staging, item)
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)

    sandbox = BuildSandbox(root=staging, seed_dir=str(SEED_DIR))
    brief = build_brief(
        brand=brand,
        profile=profile,
        goal=goal,
        portals=portals,
        extra="You are EVOLVING an existing World: rotate the lure, refresh mock data and add/vary a portal."
        if seed_from_current
        else "",
    )
    prov_result = provider.build(sandbox, SYSTEM_PROMPT, brief)

    # Final inertness gate: re-validate the ENTIRE tree on disk (does not trust the tools).
    problems = validate_tree(staging)
    if problems:
        shutil.rmtree(staging, ignore_errors=True)
        return {
            "ok": False,
            "published": False,
            "error": "final inertness validation failed; live World intact",
            "problems": problems[:50],
            "provider_result": prov_result,
        }

    _publish(staging, world_path)
    report = {
        "ok": True,
        "published": True,
        "world_path": world_path,
        "files": sandbox_file_count(world_path),
        "bait": None,
        "provider_result": prov_result,
        "note": "Restart/reload the honeypot process so it serves the new World "
        "(the World is loaded at startup).",
    }

    if import_bait and sandbox.bait_pack is not None:
        report["bait"] = import_bait_pack(sandbox.bait_pack, activate=activate)
    return report


def import_bait_pack(pack: dict, *, activate: bool = True) -> dict:
    """Import the lure pack produced by the agent as the active scenario."""
    try:
        from ..db import SessionLocal
        from ..scenarios import import_pack

        with SessionLocal() as db:
            s = import_pack(db, pack, activate)
            return {
                "ok": True,
                "scenario_id": s.id,
                "name": s.name,
                "active": s.is_active,
                "nodes": len(pack.get("nodes", [])),
            }
    except Exception as e:  # do not take down the published build over an import failure
        logger.warning("[worldsmith] lure pack import failed: %s", e)
        return {"ok": False, "error": str(e)}


def sandbox_file_count(root: str) -> int:
    n = 0
    for _dp, _dn, fn in os.walk(root):
        n += len(fn)
    return n
