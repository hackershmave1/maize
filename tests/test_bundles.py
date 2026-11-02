"""Tests for the static bundle generator (agentless mode).

Checks that `generate_for_sensor` creates the requested bundles, that the files
exist, that the structure VARIES between bundles, that nothing placed is executable and
that the MANIFEST travels inside the archive. The conftest isolates the DB.
"""

import json
import tarfile
import zipfile
from uuid import uuid4

from moqesh.bundles import bundles_dir, generate_for_sensor
from moqesh.db import SessionLocal, init_db
from moqesh.models import Sensor

# Extensions a web server could execute: none must appear in the lure.
_EXECUTABLES = (".php", ".sh", ".cgi", ".aspx", ".jsp", ".pl", ".py", ".phtml")


def _read_manifest(path) -> tuple[dict, list[str]]:
    """Open the bundle (zip or tar.gz) and return (manifest, member names)."""
    if path.name.endswith(".zip"):
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            assert "MANIFEST.json" in names
            return json.loads(zf.read("MANIFEST.json")), names
    with tarfile.open(path, "r:gz") as tf:
        names = tf.getnames()
        assert "MANIFEST.json" in names
        extraido = tf.extractfile("MANIFEST.json")
        assert extraido is not None
        return json.loads(extraido.read()), names


def test_generate_for_sensor_creates_varied_inert_bundles():
    init_db()
    with SessionLocal() as db:
        sensor = Sensor(
            name="agentless-edge",
            kind="agentless",
            realism_level=4,
            vocabulary_theme="devops",
            base_path="/lure",
            key_id=uuid4().hex[:16],  # unique: avoids clashing with the seeded 'local' sensor
        )
        db.add(sensor)
        db.commit()
        db.refresh(sensor)

        filas = generate_for_sensor(db, sensor, count=3)

        # Exactly 3 persisted rows are created.
        assert len(filas) == 3
        assert all(f.id is not None and f.sensor_id == sensor.id for f in filas)

        manifests: list[dict] = []
        for fila in filas:
            path = bundles_dir() / fila.filename
            # The archive exists on disk and is not empty.
            assert path.exists() and path.stat().st_size > 0
            assert fila.archive_format in ("zip", "tgz")

            manifest, _names = _read_manifest(path)
            manifests.append(manifest)

            # The MANIFEST carries the seed and date (audit/uninstall).
            assert manifest["seed"] == fila.seed
            assert manifest["created_at"]
            assert manifest["files"], "the bundle should place files"

            # No placed file has an executable extension.
            for archive in manifest["files"]:
                assert not archive.lower().endswith(_EXECUTABLES), archive

        # At least two bundles differ in structure (paths relative to the root).
        relative_sets = [frozenset(p.split("/", 1)[1] for p in m["files"]) for m in manifests]
        assert len(set(relative_sets)) >= 2, "bundles should not share structure"
