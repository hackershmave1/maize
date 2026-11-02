"""World: multi-site inert static serving (Phases A/B)."""

import json
import os

from fastapi.testclient import TestClient

from moqesh.world import SEED_DIR, STREAM_THRESHOLD, World, content_type_for, ensure_seeded


def _write_world(root, mounts, files):
    """Create a temporary World: `files` = {relative_path: bytes}, `mounts` = list of dicts."""
    for rel, data in files.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)
    with open(os.path.join(root, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"mounts": mounts}, f)


def test_content_type_for():
    assert content_type_for("x.html").startswith("text/html")
    assert content_type_for("x.json").startswith("application/json")
    assert content_type_for("x.svg") == "image/svg+xml"
    assert content_type_for("x.unknownext") == "application/octet-stream"


def test_seed_world_loads_and_serves_multisite():
    w = World(str(SEED_DIR))
    assert w.active
    # Root portal (console).
    root = w.resolve("/")
    assert root and b"Harborline" in root.body and root.content_type.startswith("text/html")
    # Portals mounted in different subdirectories.
    docs = w.resolve("/docs/")
    assert docs and b"Harborline Docs" in docs.body
    doc_page = w.resolve("/docs/getting-started.html")
    assert doc_page and b"Getting started" in doc_page.body
    # Mock data (JSON) with its content-type.
    summary = w.resolve("/status/api/summary.json")
    assert summary and summary.content_type.startswith("application/json")
    assert b"operational" in summary.body
    # Static asset.
    fav = w.resolve("/favicon.svg")
    assert fav and fav.content_type == "image/svg+xml"


def test_dynamic_values_filled_by_moqesh():
    # Health/status endpoints are NOT frozen: Moqesh fills in tokens when serving.
    w = World(str(SEED_DIR))
    health = w.resolve("/api/health.json")
    assert health and health.dynamic  # marked dynamic -> served without ETag/Last-Modified
    body = health.body.decode()
    assert "{{moqesh." not in body  # the tokens were substituted
    import json as _json

    data = _json.loads(body)
    assert isinstance(data["uptime_seconds"], int) and data["uptime_seconds"] > 0
    assert data["timestamp"].endswith("Z")
    # The static root is NOT dynamic.
    assert w.resolve("/").dynamic is False


def test_unlinked_paths_are_404():
    w = World(str(SEED_DIR))
    assert w.resolve("/nonexistent-xyz") is None  # the root portal does not have it -> 404
    assert w.resolve("/docs/nope.html") is None  # docs owns it but it does not exist -> 404 (no fallback to root)
    assert w.resolve("/wp-login.php") is None


def test_path_traversal_blocked():
    w = World(str(SEED_DIR))
    assert w.resolve("/../../../etc/passwd") is None
    assert w.resolve("/docs/../../../../etc/passwd") is None


def test_ensure_seeded_into_empty_dir(tmp_path):
    dest = os.path.join(str(tmp_path), "world")
    assert not os.path.exists(os.path.join(dest, "manifest.json"))
    assert ensure_seeded(dest) is True
    assert os.path.isfile(os.path.join(dest, "manifest.json"))
    w = World(dest)
    assert w.active and w.resolve("/") is not None
    # Idempotent: does not fail if a World already exists.
    assert ensure_seeded(dest) is True


def test_autoindex_lists_directory(tmp_path):
    root = str(tmp_path / "world")
    _write_world(
        root,
        [{"prefix": "/data", "dir": "sites/data", "autoindex": True}],
        {
            "sites/data/2023/file_000001.txt": b"x" * 200,
            "sites/data/readme.txt": b"y" * 200,
        },
    )
    w = World(root)
    r = w.resolve("/data/")
    assert r is not None and r.content_type.startswith("text/html") and not r.stream
    body = r.body.decode()
    assert "Index of /data/" in body
    assert '<a href="../">../</a>' in body
    assert 'href="/data/2023/"' in body  # subdir linked as an absolute path
    assert 'href="/data/readme.txt"' in body
    # Listing of a subdirectory.
    sub = w.resolve("/data/2023/")
    assert sub and 'href="/data/2023/file_000001.txt"' in sub.body.decode()
    # A real file is still served; a missing path -> 404 (None).
    assert w.resolve("/data/readme.txt") is not None
    assert w.resolve("/data/nope/") is None


def test_no_autoindex_dir_is_404(tmp_path):
    root = str(tmp_path / "world")
    _write_world(root, [{"prefix": "/", "dir": "sites/x"}], {"sites/x/sub/f.txt": b"z" * 100})
    w = World(root)
    assert w.resolve("/sub/") is None  # no autoindex or index.html -> 404
    assert w.resolve("/sub/f.txt") is not None


def test_large_file_streams_small_in_memory(tmp_path):
    root = str(tmp_path / "world")
    big = b"A" * (STREAM_THRESHOLD + 1000)
    _write_world(
        root,
        [{"prefix": "/data", "dir": "sites/data"}],
        {"sites/data/big.txt": big, "sites/data/small.txt": b"B" * 100},
    )
    w = World(root)
    rb = w.resolve("/data/big.txt")
    assert rb is not None and rb.stream and rb.body == b""
    assert rb.path == os.path.join(root, "sites/data/big.txt") and rb.size == len(big)
    rs = w.resolve("/data/small.txt")
    assert rs is not None and not rs.stream and rs.body == b"B" * 100


def test_honeypot_streams_large_world_file(tmp_path):
    from moqesh.honeypot import app

    root = str(tmp_path / "world")
    n = STREAM_THRESHOLD + 2048
    _write_world(
        root,
        [{"prefix": "/data", "dir": "sites/data", "autoindex": True}],
        {"sites/data/big.txt": b"Z" * n},
    )
    with TestClient(app) as client:
        app.state.world = World(root)
        r = client.get("/data/big.txt")
        assert r.status_code == 200
        assert int(r.headers["content-length"]) == n and len(r.content) == n
        idx = client.get("/data/")
        assert idx.status_code == 200 and "Index of /data/" in idx.text and "big.txt" in idx.text


def test_honeypot_serves_world_only_bytes():
    # Integration: mount the World on the honeypot and check it serves real files (not the labyrinth).
    from moqesh.honeypot import app

    with TestClient(app) as client:
        app.state.world = World(str(SEED_DIR))  # explicit override (the World is off in tests)
        r = client.get("/", headers={"user-agent": "Mozilla/5.0"})
        assert r.status_code == 200 and "Harborline" in r.text
        assert r.headers.get("last-modified") and r.headers.get("etag")  # static-file headers
        rj = client.get("/status/api/summary.json")
        assert rj.status_code == 200 and rj.headers["content-type"].startswith("application/json")
        assert client.get("/nope-xyz").status_code == 404  # anything absent -> real 404 (not the labyrinth)
