"""World: INERT static content served by the honeypot (multi-site).

Replaces the generated labyrinth as the primary content source. A "World" is a
tree of real files on disk (a data volume) + a `manifest.json` that mounts
one or more **portals** under different path prefixes (like a server hosting
several sites/vhosts). The honeypot ONLY serves bytes: it never executes anything (no interpreter,
no backend, no real auth), so it adds realism without introducing attack surface.

On-disk structure (`MOQESH_WORLD_PATH`, e.g. /app/data/world):
    world/
      manifest.json            # {"mounts": [{"prefix": "/docs", "dir": "sites/docs", "spa": false}, ...]}
      sites/<portal>/index.html, assets/..., api/*.json   # static files + mock data

Security: path resolution is confined to each portal directory (no escape
via `..`), and resolving a path never reads outside the World.
"""

from __future__ import annotations

import html
import json
import logging
import mimetypes
import os
import re
import shutil
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

logger = logging.getLogger("moqesh.world")

# Static files above this threshold are STREAMED (FileResponse) instead of being
# read whole into memory: this lets us serve voluminous trees (e.g. generated with genbig) without
# exhausting the honeypot's RAM. Small ones (and dynamic ones with tokens) still go in memory.
STREAM_THRESHOLD = 1 << 20  # 1 MiB

# A thin layer of dynamic values computed by MOQESH (not the portals): avoids the giveaway of
# "frozen" health/status endpoints. A World file may include these tokens and
# Moqesh substitutes them when serving. It runs no portal code; it only fills in a few values.
_DYN_RE = re.compile(r"\{\{moqesh\.(now_iso|uptime_seconds|minutes_ago)\}\}")
_DEPLOY_BASE = 1_748_000_000  # ~2025-05; uptime = now - base (grows on every request)


def _dyn_value(key: str) -> str:
    now = int(time.time())
    if key == "now_iso":
        return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    if key == "uptime_seconds":
        return str(max(0, now - _DEPLOY_BASE))
    if key == "minutes_ago":
        return str(now // 60 % 7 + 1)
    return ""

# Directory of the packaged curated seed (inert portal templates).
SEED_DIR = Path(__file__).parent / "worlds" / "seed"

# Explicit content types (everything else falls back to mimetypes). Text carries a charset.
_CT_TEXT = {
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".xml": "application/xml",
    ".svg": "image/svg+xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
}


def content_type_for(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in _CT_TEXT:
        base = _CT_TEXT[ext]
        return base if base.startswith("image/") else f"{base}; charset=utf-8"
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def default_world_path(db_path: str) -> str:
    """World next to the DB (same persistent volume)."""
    return os.path.join(os.path.dirname(os.path.abspath(db_path)) or ".", "world")


@dataclass(frozen=True)
class WorldFile:
    body: bytes
    content_type: str
    dynamic: bool = False  # True if Moqesh filled in dynamic tokens (served without ETag/Last-Modified)
    path: str | None = None  # on-disk path of the file (present when stream=True)
    size: int = 0  # size in bytes (for streaming)
    stream: bool = False  # True = stream from `path` (large file), not from `body`


@dataclass(frozen=True)
class _Mount:
    prefix: str  # no trailing slash, "/" for the root
    dir: str  # absolute path of the portal
    spa: bool  # if True, paths not found under the mount serve index.html (SPA app)
    autoindex: bool = False  # if True, a directory without index.html serves a listing (server style)


class World:
    """Load a manifest and resolve paths to static files (read-only)."""

    def __init__(self, root: str) -> None:
        self.root = os.path.abspath(root)
        self.mounts: list[_Mount] = []
        self.active = False
        self._load()

    def _load(self) -> None:
        manifest = os.path.join(self.root, "manifest.json")
        if not os.path.isfile(manifest):
            return
        try:
            data = json.loads(Path(manifest).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("[world] unreadable manifest.json at %s", self.root)
            return
        mounts: list[_Mount] = []
        for m in data.get("mounts", []):
            if not isinstance(m, dict):
                continue
            prefix = "/" + str(m.get("prefix", "/")).strip("/")
            d = os.path.abspath(os.path.join(self.root, str(m.get("dir", ""))))
            # The portal dir must stay INSIDE the World (anti-escape).
            if d != self.root and not d.startswith(self.root + os.sep):
                continue
            if not os.path.isdir(d):
                continue
            mounts.append(
                _Mount(
                    prefix=prefix if prefix != "/" else "/",
                    dir=d,
                    spa=bool(m.get("spa")),
                    autoindex=bool(m.get("autoindex")),
                )
            )
        # Most specific first (longest-prefix match).
        mounts.sort(key=lambda mt: len(mt.prefix), reverse=True)
        self.mounts = mounts
        self.active = bool(mounts)

    def resolve(self, path: str) -> WorldFile | None:
        """Return the file to serve, or None if there is nothing (the caller returns 404).

        The FIRST mount that matches the path "owns" that space: if the file is not found
        inside, it is a 404 (it does not fall through to another mount), like a real vhost/app.
        """
        if not self.active:
            return None
        path = "/" + path.lstrip("/") if path else "/"
        for mt in self.mounts:
            if mt.prefix == "/":
                rel = path.lstrip("/")
            elif path == mt.prefix or path.startswith(mt.prefix + "/"):
                rel = path[len(mt.prefix) :].lstrip("/")
            else:
                continue
            return self._serve_within(mt, rel)
        return None

    def _serve_within(self, mt: _Mount, rel: str) -> WorldFile | None:
        target = os.path.abspath(os.path.join(mt.dir, rel))
        # Anti-traversal: the target must stay inside the portal directory.
        if target != mt.dir and not target.startswith(mt.dir + os.sep):
            return None
        if os.path.isdir(target):
            index = os.path.join(target, "index.html")
            if os.path.isfile(index):
                return self._read(index)
            if mt.autoindex:
                return self._autoindex(mt, target, rel)
            return self._spa_fallback(mt)
        if os.path.isfile(target):
            try:
                size = os.path.getsize(target)
            except OSError:
                return None
            # Large file -> streaming (not read into memory; no token substitution).
            if size > STREAM_THRESHOLD:
                return WorldFile(body=b"", content_type=content_type_for(target), path=target, size=size, stream=True)
            return self._read(target)
        return self._spa_fallback(mt)

    def _autoindex(self, mt: _Mount, target: str, rel: str) -> WorldFile | None:
        """Generate a directory listing (nginx autoindex style) for a dir without index.html.

        Only lists the direct children of `target` (already validated inside the mount); the links are
        absolute paths of the site itself. It is the 'open directory' decoy that invites an
        agent to download a voluminous tree of real files (finite token burn)."""
        prefix = "" if mt.prefix == "/" else mt.prefix
        url = (prefix + "/" + rel) if rel else (prefix + "/")
        if not url.startswith("/"):
            url = "/" + url
        if not url.endswith("/"):
            url += "/"
        try:
            names = sorted(os.listdir(target))
        except OSError:
            return None
        dirs = [n for n in names if os.path.isdir(os.path.join(target, n))]
        files = [n for n in names if os.path.isfile(os.path.join(target, n))]
        rows = ['<a href="../">../</a>']
        for n in dirs:
            mtime = self._fmt_time(os.path.getmtime(os.path.join(target, n)))
            rows.append(self._index_row(html.escape(url + n + "/"), html.escape(n + "/"), mtime, "-"))
        for n in files:
            st = os.stat(os.path.join(target, n))
            rows.append(
                self._index_row(html.escape(url + n), html.escape(n), self._fmt_time(st.st_mtime), str(st.st_size))
            )
        title = html.escape(url)
        body = (
            f"<html>\n<head><title>Index of {title}</title></head>\n<body>\n"
            f"<h1>Index of {title}</h1><hr><pre>\n" + "\n".join(rows) + "\n</pre><hr></body>\n</html>\n"
        )
        return WorldFile(body=body.encode(), content_type="text/html; charset=utf-8")

    @staticmethod
    def _fmt_time(ts: float) -> str:
        return datetime.fromtimestamp(ts, UTC).strftime("%d-%b-%Y %H:%M")

    @staticmethod
    def _index_row(href: str, disp: str, mtime: str, size: str) -> str:
        name_cell = disp if len(disp) <= 50 else disp[:47] + "..&gt;"
        pad = " " * max(1, 51 - len(name_cell))
        return f'<a href="{href}">{name_cell}</a>{pad}{mtime}{size:>20}'

    def _spa_fallback(self, mt: _Mount) -> WorldFile | None:
        if not mt.spa:
            return None
        index = os.path.join(mt.dir, "index.html")
        return self._read(index) if os.path.isfile(index) else None

    @staticmethod
    def _read(abs_path: str) -> WorldFile | None:
        try:
            body = Path(abs_path).read_bytes()
        except OSError:
            return None
        ct = content_type_for(abs_path)
        # Dynamic token substitution (only if the file declares them).
        if b"{{moqesh." in body:
            try:
                text = body.decode("utf-8")
            except UnicodeDecodeError:
                return WorldFile(body=body, content_type=ct)
            new = _DYN_RE.sub(lambda m: _dyn_value(m.group(1)), text)
            if new != text:
                return WorldFile(body=new.encode(), content_type=ct, dynamic=True)
        return WorldFile(body=body, content_type=ct)


def ensure_seeded(world_path: str) -> bool:
    """If the World is empty (no manifest) and the packaged seed exists, copy it.

    Idempotent: does not touch an already provisioned World (e.g. by the agent). Returns True
    if after the call there is a World with a manifest."""
    manifest = os.path.join(world_path, "manifest.json")
    if os.path.isfile(manifest):
        return True
    seed_manifest = SEED_DIR / "manifest.json"
    if not seed_manifest.is_file():
        return False
    try:
        os.makedirs(world_path, exist_ok=True)
        for item in SEED_DIR.iterdir():
            dest = os.path.join(world_path, item.name)
            if item.is_dir():
                shutil.copytree(item, dest, dirs_exist_ok=True)
            else:
                shutil.copy2(item, dest)
        logger.info("[world] semilla copiada a %s", world_path)
        return True
    except OSError:
        logger.warning("[world] could not seed the World at %s", world_path, exc_info=True)
        return False
