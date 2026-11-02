"""Static bundle generator for agentless mode.

Materializes FINITE, RANDOM snapshots of the labyrinth and packs them into a
ZIP or tar.gz that the user unpacks on their server as a lure. Unlike
the live honeypot (infinite and deterministic per request), here a bounded tree is
frozen: depth, branches and file count are chosen at random per bundle,
so two downloads never share structure, size or patterns (key to
anti-fingerprint).

Placement safety: content is written with INERT extensions so that
the customer's web server serves it as DATA and never executes it (see `_safe_path`
and the `serve-config/` snippets). Only the stdlib is used for packaging.
"""

from __future__ import annotations

import io
import json
import random
import tarfile
import zipfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from uuid import uuid4

from sqlalchemy.orm import Session

from .config import settings
from .labyrinth import LabyrinthGenerator, LabyrinthOptions
from .models import Sensor, SensorBundle

# Extensions a web server could EXECUTE on the customer's host: never
# placed as-is; neutralized to an inert extension (`.txt`).
_EXECUTABLES = (".php", ".sh", ".cgi", ".aspx", ".jsp", ".pl", ".py", ".phtml")

# Plausible names for the lure's root folder (a hex suffix is appended).
_ROOT_POOL = ["assets", "static", "public", "data", "files", "shared", "content", "docs", "cdn", "media"]


def bundles_dir() -> Path:
    """Directory where bundles are written (next to the DB). Created if missing."""
    directory = Path(settings.db_path).resolve().parent / "bundles"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


# ----------------------------- paths / safety -------------------------------


def _depth(path: str) -> int:
    """Path levels (the root '/' is 0)."""
    t = path.strip("/")
    return 0 if not t else len(t.split("/"))


def _is_safe(rel: str) -> bool:
    """Prevents traversal: no empty segment, '.', '..' or backslash."""
    return all(p not in ("", ".", "..") and "\\" not in p for p in rel.split("/"))


def _safe_path(path: str, node_kind: str) -> str:
    """Convert a labyrinth path into a relative path of an INERT file.

    - Directories (`/ops/` or `/`) -> `ops/index.html` / `index.html`.
    - Binaries (`node_kind == "binary"`) -> `.bin`.
    - Executable extensions -> `.txt` is appended (keeps the lure name).
    """
    rel = path.strip("/")
    if path.endswith("/") or rel == "":
        base = (rel + "/") if rel else ""
        return base + "index.html"
    if node_kind == "binary":
        return str(PurePosixPath(rel).with_suffix(".bin"))
    if PurePosixPath(rel).suffix.lower() in _EXECUTABLES:
        return rel + ".txt"
    return rel


def _root_name(rng: random.Random) -> str:
    """Random root folder name (different per bundle thanks to the hex suffix)."""
    return rng.choice(_ROOT_POOL) + "-" + "".join(rng.choices("0123456789abcdef", k=6))


# ----------------------------- materialization ------------------------------


def _materialize(gen: LabyrinthGenerator, opts: LabyrinthOptions, rng: random.Random) -> tuple[dict[str, bytes], dict]:
    """Walk the labyrinth from '/' and return `(decoy, summary)`.

    `decoy` maps relative path (without the root folder) -> bytes, and includes the
    `index.html` of every visited directory and the leaf files. The walk is
    FINITE and its size VARIES per bundle: depth (2-5), branches per level and a
    file target are drawn with the bundle's own `rng`.
    """
    max_depth = rng.randint(2, 5)
    target_files = rng.randint(4, 28)
    max_dirs = rng.randint(3, 10)

    decoy: dict[str, bytes] = {}
    n_files = 0
    n_dirs = 0
    deepest = 0

    queue: list[tuple[str, int]] = [("/", 0)]
    seen: set[str] = {"/"}

    while queue:
        path, depth = queue.pop(0)
        deepest = max(deepest, depth)

        # Materialize the current directory's index.html.
        rel_dir = _safe_path(path, "dir")
        if _is_safe(rel_dir) and rel_dir not in decoy:
            decoy[rel_dir] = gen.generate(opts, path).body
            n_dirs += 1

        links = gen.links_for(opts, path)
        child_dirs = [e for e in links if e.endswith("/")]
        child_files = [e for e in links if not e.endswith("/")]
        rng.shuffle(child_dirs)
        rng.shuffle(child_files)

        # Random subset of this level's files (variable density).
        for link in child_files[: rng.randint(0, len(child_files))]:
            if n_files >= target_files:
                break
            page = gen.generate(opts, link)
            rel = _safe_path(link, page.node_kind)
            if not _is_safe(rel) or rel in decoy:
                continue
            decoy[rel] = page.body
            n_files += 1
            deepest = max(deepest, _depth(link))

        # Descend into a random subset of subdirectories (bounded tree).
        if depth < max_depth and child_dirs and len(seen) < max_dirs:
            cuantos = rng.randint(1, min(3, len(child_dirs)))
            for link in child_dirs[:cuantos]:
                if link in seen or len(seen) >= max_dirs:
                    continue
                seen.add(link)
                queue.append((link, depth + 1))

        if n_files >= target_files:
            break

    summary = {"files": n_files, "dirs": n_dirs, "depth": deepest}
    return decoy, summary


# ----------------------------- empaquetado ----------------------------------


def _write_zip(dest: Path, members: dict[str, bytes]) -> None:
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in members.items():
            zf.writestr(name, data)


def _write_tgz(dest: Path, members: dict[str, bytes]) -> None:
    with tarfile.open(dest, "w:gz") as tf:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))


# ----------------------------- bundle metadata ------------------------------


def _uninstall_sh(paths: list[str], root: str) -> str:
    """POSIX script that deletes EXACTLY what is listed in MANIFEST.json."""
    body = [
        "#!/bin/sh",
        "# Moqesh: bundle uninstaller.",
        "# Deletes EXACTLY the placed files (those in MANIFEST.json).",
        "set -eu",
        'cd "$(dirname "$0")"',
        "for f in \\",
    ]
    body += [f'  "{path}" \\' for path in paths]
    body += [
        "  ; do",
        '  rm -f -- "./$f"',
        "done",
        f'find "./{root}" -type d -empty -delete 2>/dev/null || true',
        'echo "[moqesh] lure removed."',
        "",
    ]
    return "\n".join(body)


def _snippet_nginx(root: str) -> str:
    return (
        "# Moqesh: serve the lure as PLAIN TEXT and WITHOUT execution (nginx).\n"
        "# Paste this block inside your site's server { } and adjust the path.\n"
        "location /lure/ {\n"
        f"    alias /var/www/{root}/;\n"
        "    autoindex off;\n"
        "    default_type text/plain;\n"
        "    types { }                       # overrides type mapping: everything is text\n"
        "    add_header X-Content-Type-Options nosniff;\n"
        "    # Do not add fastcgi_pass/proxy_pass here: nothing must execute.\n"
        "    location ~* \\.(php|cgi|pl|py|sh|jsp|aspx)$ { return 403; }\n"
        "}\n"
    )


def _snippet_htaccess() -> str:
    return (
        "# Moqesh: serve the lure as PLAIN TEXT and WITHOUT execution (Apache).\n"
        "# Copy this file as .htaccess inside the lure folder.\n"
        "Options -ExecCGI -Indexes +FollowSymLinks\n"
        "RemoveHandler .php .cgi .pl .py .sh .jsp .aspx .phtml\n"
        "RemoveType .php .cgi .pl .py\n"
        "php_flag engine off\n"
        "SetHandler none\n"
        "ForceType text/plain\n"
        "<IfModule mod_headers.c>\n"
        "    Header set X-Content-Type-Options nosniff\n"
        "</IfModule>\n"
    )


def _snippet_caddy(root: str) -> str:
    return (
        "# Moqesh: serve the lure as PLAIN TEXT and WITHOUT execution (Caddy).\n"
        "lure.example.com {\n"
        f"    root * /var/www/{root}\n"
        "    header Content-Type text/plain\n"
        "    header X-Content-Type-Options nosniff\n"
        "    file_server\n"
        "    # No php_fastcgi or reverse_proxy: content is only served, never executed.\n"
        "}\n"
    )


# ----------------------------- public API -----------------------------------


def generate_for_sensor(db: Session, sensor: Sensor, count: int = 3) -> list[SensorBundle]:
    """Generate `count` bundles for `sensor`, write them to disk and record them.

    Each bundle has its own seed (`uuid4`), different structure and size, a different
    root folder name and a random archive format (zip or tar.gz). Returns
    the created `SensorBundle` rows.
    """
    dest_dir = bundles_dir()
    gen = LabyrinthGenerator()
    filas: list[SensorBundle] = []

    for _ in range(count):
        seed = uuid4().hex
        rng = random.Random(seed)
        opts = LabyrinthOptions(
            seed=seed,
            mode="Template",
            realism_level=sensor.realism_level,
            vocabulary_theme=sensor.vocabulary_theme,
        )

        decoy, summary = _materialize(gen, opts, rng)

        # Random root folder: the lure content hangs off it.
        root = _root_name(rng)
        members: dict[str, bytes] = {}
        manifest_paths: list[str] = []
        for rel, data in decoy.items():
            member = f"{root}/{rel}"
            members[member] = data
            manifest_paths.append(member)
        manifest_paths.sort()

        # Random archive format.
        fmt = rng.choice(["zip", "tgz"])
        ext = ".zip" if fmt == "zip" else ".tar.gz"
        filename = f"{sensor.id}-{seed[:8]}{ext}"

        manifest = {
            "sensor_id": sensor.id,
            "seed": seed,
            "created_at": datetime.now(UTC).isoformat(),
            "root": root,
            "archive_format": fmt,
            "summary": summary,
            "files": manifest_paths,
        }
        members["MANIFEST.json"] = json.dumps(manifest, indent=2).encode()
        members["uninstall.sh"] = _uninstall_sh(manifest_paths, root).encode()
        members["serve-config/nginx.conf"] = _snippet_nginx(root).encode()
        members["serve-config/.htaccess"] = _snippet_htaccess().encode()
        members["serve-config/Caddyfile"] = _snippet_caddy(root).encode()

        dest = dest_dir / filename
        if fmt == "zip":
            _write_zip(dest, members)
        else:
            _write_tgz(dest, members)

        fila = SensorBundle(
            sensor_id=sensor.id,
            filename=filename,
            seed=seed,
            archive_format=fmt,
            structure_summary=json.dumps(summary),
        )
        db.add(fila)
        filas.append(fila)

    db.commit()
    return filas
