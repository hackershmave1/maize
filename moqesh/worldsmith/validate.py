"""Worldsmith inertness safety net (defense in depth).

EVERY byte the agent wants to write goes through here BEFORE touching disk, and the
entire tree is re-validated BEFORE being published to the live World. The non-negotiable
principle: Moqesh only serves **static bytes** and never executes portal
content. This module enforces that mechanically (it does not trust the prompt):

  1. Safe paths: relative, no `..`, no absolute/NUL, extension on the allowlist.
  2. No server-side execution markers (`<?php`, `<% %>`, shebangs...).
  3. No ACTIVE loads/callbacks to external origins (script/link/img/iframe/form,
     fetch/import/XHR/WebSocket, CSS url()/@import). Everything stays same-origin: the
     "logins" post to the Moqesh gate, never to a real backend or a beacon.
  4. Size limits.

Content MAY include *fabricated* secrets/credentials (they are the lure); the
"one single live credential" invariant is enforced on the scenario-pack side,
not by this validator, whose job is exclusively INERTNESS.
"""

from __future__ import annotations

import os
import posixpath
import re

# Allowed extensions -> if text, its content is scanned; binaries only by size/type.
_TEXT_EXTS = {
    ".html", ".htm", ".css", ".js", ".mjs", ".json", ".txt", ".md",
    ".csv", ".xml", ".svg", ".yaml", ".yml", ".webmanifest", ".map",
}
_BINARY_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".avif",
    ".woff", ".woff2", ".ttf", ".otf", ".eot", ".pdf",
}
ALLOWED_EXTS = _TEXT_EXTS | _BINARY_EXTS

MAX_TEXT_BYTES = 512 * 1024          # 512 KiB per text file
MAX_BINARY_BYTES = 4 * 1024 * 1024   # 4 MiB per binary (fonts/images)
MAX_REL_DEPTH = 10
MAX_REL_LEN = 240

# The only template pattern allowed in World files: Moqesh dynamic tokens.
_ALLOWED_DYNAMIC = re.compile(r"\{\{\s*moqesh\.(?:now_iso|uptime_seconds|minutes_ago)\s*\}\}")
# Scenario engine placeholders (ONLY valid in lure bodies, not in World files):
# the ScenarioEngine substitutes them when serving; they never execute.
_SCENARIO_PLACEHOLDER = re.compile(r"\{\{\s*(?:brand|slug|token|cred:[\w-]+|user:[\w-]+)\s*\}\}")

# Server-side execution markers: forbidden anywhere.
_SERVER_EXEC = [
    (re.compile(r"<\?php", re.I), "open PHP tag (<?php)"),
    (re.compile(r"<\?=", re.I), "PHP short-echo (<?=)"),
    (re.compile(r"<\?(?![x])", re.I), "processing tag <? ...?>"),  # allows <?xml
    (re.compile(r"<%[-=@!]?"), "scriptlet ASP/JSP/EJS (<% %>)"),
    (re.compile(r"#!\s*/"), "script shebang (#!/...)"),
    (re.compile(r"\{%[-\s]"), "server template block ({% %})"),
    (re.compile(r"<jsp:", re.I), "JSP tag"),
]

# ACTIVE loads/callbacks to external origins (absolute or protocol-relative).
_EXT = r"(?:https?:)?//"  # http://, https:// or //host
_ACTIVE_EXTERNAL = [
    (re.compile(r"<script\b[^>]*\bsrc\s*=\s*['\"]?\s*" + _EXT, re.I), "external <script src>"),
    (re.compile(r"<link\b[^>]*\bhref\s*=\s*['\"]?\s*" + _EXT, re.I), "external <link href>"),
    (re.compile(r"<iframe\b[^>]*\bsrc\s*=\s*['\"]?\s*" + _EXT, re.I), "external <iframe src>"),
    (re.compile(r"<img\b[^>]*\bsrc\s*=\s*['\"]?\s*" + _EXT, re.I), "external <img src>"),
    (
        re.compile(r"<(?:audio|video|source|track|embed|object)\b[^>]*\b(?:src|data)\s*=\s*['\"]?\s*" + _EXT, re.I),
        "external media",
    ),
    (re.compile(r"<form\b[^>]*\baction\s*=\s*['\"]?\s*" + _EXT, re.I), "external <form action>"),
    (re.compile(r"\bfetch\s*\(\s*['\"]\s*" + _EXT, re.I), "external fetch()"),
    (re.compile(r"\bimport\s*\(\s*['\"]\s*" + _EXT, re.I), "external dynamic import()"),
    (re.compile(r"\bimport\b[^;\n]*\bfrom\s*['\"]\s*" + _EXT, re.I), "external import ... from"),
    (re.compile(r"\bnew\s+WebSocket\s*\(\s*['\"]\s*wss?://", re.I), "external WebSocket"),
    (re.compile(r"\bnew\s+EventSource\s*\(\s*['\"]\s*" + _EXT, re.I), "external EventSource"),
    (re.compile(r"\.open\s*\(\s*['\"][A-Z]+['\"]\s*,\s*['\"]\s*" + _EXT, re.I), "external XMLHttpRequest"),
    (re.compile(r"@import\s+(?:url\()?\s*['\"]?\s*" + _EXT, re.I), "external CSS @import"),
    (re.compile(r"\burl\(\s*['\"]?\s*" + _EXT, re.I), "external CSS url()"),
    (re.compile(r"\bnavigator\.sendBeacon\s*\(\s*['\"]\s*" + _EXT, re.I), "external sendBeacon"),
    (re.compile(r"<(?:image|use|feimage)\b[^>]*\b(?:xlink:)?href\s*=\s*['\"]?\s*" + _EXT, re.I), "external SVG ref"),
    (re.compile(r"\bxlink:href\s*=\s*['\"]?\s*" + _EXT, re.I), "external xlink:href"),
]


class InertnessError(ValueError):
    """The path or content violates inertness; includes the specific reasons."""

    def __init__(self, path: str, reasons: list[str]) -> None:
        self.path = path
        self.reasons = reasons
        super().__init__(f"{path}: " + "; ".join(reasons))


def safe_relpath(path: str) -> str:
    """Normalize to a safe relative POSIX path or raise InertnessError.

    Rejects absolute paths, traversal (`..`), NUL, backslashes, excessive depth/length.
    """
    reasons: list[str] = []
    raw = path or ""
    if "\x00" in raw:
        reasons.append("NUL in the path")
    if "\\" in raw:
        reasons.append("backslash in the path (use '/')")
    norm = raw.replace("\\", "/").lstrip("/")
    norm = posixpath.normpath(norm)
    if norm.startswith("..") or "/../" in f"/{norm}/" or norm == "." or norm == "":
        reasons.append("traversal or empty path")
    if os.path.isabs(raw) or raw.startswith("/"):
        reasons.append("absolute path")
    if len(norm) > MAX_REL_LEN:
        reasons.append(f"path too long (>{MAX_REL_LEN})")
    if norm.count("/") + 1 > MAX_REL_DEPTH:
        reasons.append(f"excessive depth (>{MAX_REL_DEPTH})")
    ext = posixpath.splitext(norm)[1].lower()
    if ext not in ALLOWED_EXTS:
        reasons.append(f"extension not allowed: {ext or '(none)'}")
    if reasons:
        raise InertnessError(path, reasons)
    return norm


def _scan_text(body: bytes, allow_scenario: bool = False) -> list[str]:
    """Scan text content for server-side execution and external callbacks.

    `allow_scenario`: True only for lure bodies (allows `{{cred:...}}`, `{{brand}}`, etc.).
    """
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return ["non-UTF-8 text (should be binary or valid UTF-8)"]
    reasons: list[str] = []
    for rx, label in _SERVER_EXEC:
        if rx.search(text):
            reasons.append(f"server execution marker: {label}")
    # Mask the allowed tokens so they do not trigger the unknown `{{ ... }}` check.
    scrubbed = _ALLOWED_DYNAMIC.sub("", text)
    if allow_scenario:
        scrubbed = _SCENARIO_PLACEHOLDER.sub("", scrubbed)
    if re.search(r"\{\{", scrubbed):
        allowed = "{{moqesh.*}} (+ scenario placeholders)" if allow_scenario else "{{moqesh.*}}"
        reasons.append(f"unknown template expression ({{{{ ... }}}}); only {allowed} is allowed")
    for rx, label in _ACTIVE_EXTERNAL:
        if rx.search(text):
            reasons.append(f"carga/callback externo: {label}")
    return reasons


def validate_file(path: str, body: bytes, *, allow_scenario_placeholders: bool = False) -> str:
    """Validate path + content of ONE file. Returns the safe relative path or raises.

    This is the only way a byte reaches the World build. `allow_scenario_placeholders`
    is used only when validating lure-pack bodies (not World files, which are served raw).
    """
    rel = safe_relpath(path)  # may raise
    ext = posixpath.splitext(rel)[1].lower()
    reasons: list[str] = []
    is_text = ext in _TEXT_EXTS
    limit = MAX_TEXT_BYTES if is_text else MAX_BINARY_BYTES
    if len(body) > limit:
        reasons.append(f"size {len(body)}B exceeds the limit {limit}B")
    if is_text:
        reasons.extend(_scan_text(body, allow_scenario=allow_scenario_placeholders))
    if reasons:
        raise InertnessError(path, reasons)
    return rel


def validate_manifest(manifest: dict, present_dirs: set[str]) -> list[str]:
    """Validate the World manifest: well-formed mounts, dirs inside the build and present.

    `present_dirs` = set of relative POSIX directory paths that exist in the build.
    Returns a list of problems (empty = ok).
    """
    problems: list[str] = []
    if not isinstance(manifest, dict):
        return ["manifest is not an object"]
    mounts = manifest.get("mounts")
    if not isinstance(mounts, list) or not mounts:
        return ["manifest.mounts empty or missing"]
    seen_prefixes: set[str] = set()
    for i, m in enumerate(mounts):
        if not isinstance(m, dict):
            problems.append(f"mount[{i}] is not an object")
            continue
        prefix = "/" + str(m.get("prefix", "/")).strip("/")
        if prefix in seen_prefixes:
            problems.append(f"mount[{i}] prefix duplicado: {prefix}")
        seen_prefixes.add(prefix)
        d = str(m.get("dir", ""))
        try:
            rel_dir = posixpath.normpath(d.replace("\\", "/").lstrip("/"))
        except Exception:
            problems.append(f"mount[{i}] invalid dir: {d!r}")
            continue
        if rel_dir.startswith("..") or os.path.isabs(d):
            problems.append(f"mount[{i}] dir escapes the build: {d!r}")
        elif rel_dir not in present_dirs:
            problems.append(f"mount[{i}] dir does not exist in the build: {rel_dir}")
    return problems


def validate_tree(root: str) -> list[str]:
    """Re-validate the ENTIRE build (final gate before publishing). Returns problems (empty = ok).

    Runs every file through `validate_file` and validates `manifest.json`. Any file that is not
    allowed or has executable/external content invalidates the whole publish.
    """
    problems: list[str] = []
    present_dirs: set[str] = set()
    manifest_obj: dict | None = None
    for dirpath, _dirnames, filenames in os.walk(root):
        rel_dir = posixpath.normpath(os.path.relpath(dirpath, root).replace(os.sep, "/"))
        if rel_dir != ".":
            present_dirs.add(rel_dir)
        for name in filenames:
            abs_path = os.path.join(dirpath, name)
            rel = posixpath.normpath(os.path.relpath(abs_path, root).replace(os.sep, "/"))
            if rel == "manifest.json":
                try:
                    import json

                    manifest_obj = json.loads(open(abs_path, "rb").read().decode("utf-8"))
                except (OSError, ValueError, UnicodeDecodeError) as e:
                    problems.append(f"manifest.json ilegible: {e}")
                continue
            try:
                with open(abs_path, "rb") as f:
                    body = f.read()
                validate_file(rel, body)
            except InertnessError as e:
                problems.append(str(e))
            except OSError as e:
                problems.append(f"{rel}: could not be read ({e})")
    if manifest_obj is None:
        problems.append("manifest.json missing from the build")
    else:
        problems.extend(validate_manifest(manifest_obj, present_dirs))
    return problems
