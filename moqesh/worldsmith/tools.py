"""Worldsmith tool layer: a build sandbox where the agent can ONLY
perform safe operations. Each tool:

  * validates EVERYTHING (path + inertness) before touching disk (reuses `validate.py`);
  * is confined to a staging directory (no escape, with caps on file count and bytes);
  * NEVER raises into the model loop: returns `{"ok": False, "error", "reasons"}` so the
    agent can self-correct (e.g. "extension .php not allowed" -> retries with .html).

This is the contract every provider runs (stub / API / CLI). The agent never touches the
live World: it produces a staging dir that `builder.py` re-validates whole and publishes atomically.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import posixpath
import re
from dataclasses import dataclass, field
from pathlib import Path

from .validate import InertnessError, validate_file, validate_manifest

MAX_FILES = 400
MAX_TOTAL_BYTES = 24 * 1024 * 1024  # 24 MiB across the whole build
MAX_SEED_READ_BYTES = 256 * 1024

# A URL path (for the lure): must be site-absolute, with no scheme or traversal.
_URL_PATH_RE = re.compile(r"^/[A-Za-z0-9._~!$&'()*+,;=:@/%-]*$")


def _safe_url_path(p: str) -> str | None:
    p = (p or "").strip()
    if not p.startswith("/") or "://" in p or ".." in p or "\n" in p or len(p) > 200:
        return None
    if not _URL_PATH_RE.match(p):
        return None
    return "/" + p.strip("/") if p != "/" else "/"


@dataclass
class BuildSandbox:
    """Isolated staging where the agent builds the World. Everything writes inside here."""

    root: str
    seed_dir: str
    files: dict[str, int] = field(default_factory=dict)  # relpath -> bytes
    bait_pack: dict | None = None
    done: bool = False
    summary: str = ""

    def __post_init__(self) -> None:
        self.root = os.path.abspath(self.root)
        self.seed_dir = os.path.abspath(self.seed_dir)
        os.makedirs(self.root, exist_ok=True)

    # ---------------------------------------------------------------- escritura
    def write_file(self, path: str, content: str, encoding: str = "utf-8") -> dict:
        """Write a static file into the build. `encoding`: 'utf-8' (text) or 'base64' (binary)."""
        if encoding == "base64":
            try:
                body = base64.b64decode(content, validate=True)
            except (binascii.Error, ValueError):
                return {"ok": False, "error": "invalid base64", "path": path}
        else:
            body = content.encode("utf-8")
        try:
            rel = validate_file(path, body)
        except InertnessError as e:
            return {"ok": False, "error": "viola inertness", "reasons": e.reasons, "path": path}
        if rel not in self.files and len(self.files) >= MAX_FILES:
            return {"ok": False, "error": f"limit of {MAX_FILES} files reached", "path": path}
        projected = sum(v for k, v in self.files.items() if k != rel) + len(body)
        if projected > MAX_TOTAL_BYTES:
            return {"ok": False, "error": f"total limit of {MAX_TOTAL_BYTES} bytes exceeded", "path": path}
        abs_path = os.path.join(self.root, rel)
        # Extra defensive containment (rel is already safe, but we re-check the abspath).
        if abs_path != self.root and not os.path.abspath(abs_path).startswith(self.root + os.sep):
            return {"ok": False, "error": "path outside the sandbox", "path": path}
        os.makedirs(os.path.dirname(abs_path) or self.root, exist_ok=True)
        with open(abs_path, "wb") as f:
            f.write(body)
        self.files[rel] = len(body)
        return {"ok": True, "path": rel, "bytes": len(body), "total_files": len(self.files)}

    def delete_file(self, path: str) -> dict:
        try:
            rel = validate_file(path, b"")  # only validates the path/extension
        except InertnessError as e:
            return {"ok": False, "error": "invalid path", "reasons": e.reasons, "path": path}
        if rel not in self.files:
            return {"ok": False, "error": "no existe", "path": rel}
        try:
            os.remove(os.path.join(self.root, rel))
        except OSError:
            pass
        self.files.pop(rel, None)
        return {"ok": True, "path": rel, "total_files": len(self.files)}

    # ---------------------------------------------------------------- lectura
    def list_files(self) -> dict:
        return {"ok": True, "files": sorted(self.files), "total_files": len(self.files)}

    def read_file(self, path: str) -> dict:
        try:
            rel = validate_file(path, b"")
        except InertnessError as e:
            return {"ok": False, "error": "invalid path", "reasons": e.reasons, "path": path}
        abs_path = os.path.join(self.root, rel)
        if not os.path.isfile(abs_path):
            return {"ok": False, "error": "no existe", "path": rel}
        try:
            return {"ok": True, "path": rel, "content": Path(abs_path).read_text("utf-8")}
        except (OSError, UnicodeDecodeError):
            return {"ok": False, "error": "not readable as text", "path": rel}

    def list_seed(self) -> dict:
        out: list[str] = []
        for dp, _dn, fn in os.walk(self.seed_dir):
            for n in fn:
                out.append(os.path.relpath(os.path.join(dp, n), self.seed_dir).replace(os.sep, "/"))
        return {"ok": True, "files": sorted(out)}

    def read_seed(self, path: str) -> dict:
        rel = posixpath.normpath((path or "").replace("\\", "/").lstrip("/"))
        if rel.startswith("..") or rel in (".", ""):
            return {"ok": False, "error": "invalid seed path", "path": path}
        abs_path = os.path.abspath(os.path.join(self.seed_dir, rel))
        if not abs_path.startswith(self.seed_dir + os.sep) and abs_path != self.seed_dir:
            return {"ok": False, "error": "outside the seed", "path": path}
        if not os.path.isfile(abs_path) or os.path.getsize(abs_path) > MAX_SEED_READ_BYTES:
            return {"ok": False, "error": "no existe o demasiado grande", "path": rel}
        try:
            return {"ok": True, "path": rel, "content": Path(abs_path).read_text("utf-8")}
        except (OSError, UnicodeDecodeError):
            return {"ok": False, "error": "no legible", "path": rel}

    # ---------------------------------------------------------------- manifest
    def set_manifest(self, mounts: list[dict]) -> dict:
        """Register the portals (URL prefix -> build directory). Validates before writing."""
        if not isinstance(mounts, list) or not mounts:
            return {"ok": False, "error": "mounts must be a non-empty list"}
        present = set()
        for dp, _dn, _fn in os.walk(self.root):
            rel = posixpath.normpath(os.path.relpath(dp, self.root).replace(os.sep, "/"))
            if rel != ".":
                present.add(rel)
        manifest = {"mounts": mounts}
        problems = validate_manifest(manifest, present)
        if problems:
            return {"ok": False, "error": "invalid manifest", "reasons": problems}
        with open(os.path.join(self.root, "manifest.json"), "wb") as f:
            f.write(json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
        return {"ok": True, "mounts": len(mounts)}

    # ---------------------------------------------------------------- lure
    def plant_bait(
        self,
        credential_key: str,
        leak_paths: list[str],
        leak_body: str,
        gate_paths: list[str],
        gate_body: str,
        credential_kind: str = "bearer",
        robots_disallow: list[str] | None = None,
    ) -> dict:
        """Plant ONE live honeytoken: a leaked backup (leak_paths) -> a gated console (gate_paths).

        SPARSE-lure invariant (enforced here, not by the prompt): exactly ONE live credential,
        inert contents, safe URL paths, and the `{{cred:KEY}}` present in the leak so that
        reusing it fires `credential_reuse`. Produces the camelCase pack that `builder.py` will import.
        """
        key = (credential_key or "").strip()
        if not re.fullmatch(r"[a-zA-Z0-9_]{2,40}", key):
            return {"ok": False, "error": "invalid credential_key (use [a-zA-Z0-9_]{2,40})"}
        leaks = [_safe_url_path(p) for p in (leak_paths or [])]
        gates = [_safe_url_path(p) for p in (gate_paths or [])]
        if not leaks or any(p is None for p in leaks):
            return {"ok": False, "error": "leak_paths empty or with invalid paths"}
        if not gates or any(p is None for p in gates):
            return {"ok": False, "error": "gate_paths empty or with invalid paths"}
        if f"{{{{cred:{key}}}}}" not in leak_body:
            return {"ok": False, "error": f"leak_body must include the placeholder {{{{cred:{key}}}}}"}
        # Inertness of the bodies (as .txt and .html respectively).
        for _p, body, ext in ((leaks[0], leak_body, ".txt"), (gates[0], gate_body, ".html")):
            try:
                validate_file("bait" + ext, body.encode("utf-8"), allow_scenario_placeholders=True)
            except InertnessError as e:
                return {"ok": False, "error": f"lure body ({ext}) violates inertness", "reasons": e.reasons}
        nodes: list[dict] = []
        for p in leaks:
            nodes.append(
                {
                    "path": p,
                    "visibility": "hidden",
                    "kind": "file",
                    "stage": 1,
                    "grantsCredentialKeys": key,
                    "contentType": "text/plain; charset=utf-8",
                    "bodyTemplate": leak_body,
                }
            )
        hint = ",".join(leaks[:3])
        for p in gates:
            nodes.append(
                {
                    "path": p,
                    "visibility": "hidden",
                    "kind": "page",
                    "stage": 2,
                    "hintedByPaths": hint,
                    "requiresCredentialKey": key,
                    "contentType": "text/html; charset=utf-8",
                    "bodyTemplate": gate_body,
                }
            )
        disallow = [p for p in (_safe_url_path(x) for x in (robots_disallow or [])) if p]
        if disallow:
            lines = "User-agent: *\n" + "".join(f"Disallow: {d}\n" for d in disallow)
            nodes.append(
                {
                    "path": "/robots.txt",
                    "visibility": "linked",
                    "kind": "file",
                    "stage": 0,
                    "contentType": "text/plain; charset=utf-8",
                    "bodyTemplate": lines,
                }
            )
        self.bait_pack = {
            "name": "worldsmith-bait",
            "description": "Lure generated by the worldsmith: a honeytoken on the hunting path -> gated console.",
            "credentials": [
                {"key": key, "kind": credential_kind, "foundInPath": leaks[0], "usableAtPath": gates[0]}
            ],
            "nodes": nodes,
        }
        return {"ok": True, "credential_key": key, "leak_paths": leaks, "gate_paths": gates, "nodes": len(nodes)}

    # ---------------------------------------------------------------- fin
    def finish(self, summary: str = "") -> dict:
        self.done = True
        self.summary = (summary or "")[:2000]
        return {"ok": True, "files": len(self.files), "has_bait": self.bait_pack is not None}
