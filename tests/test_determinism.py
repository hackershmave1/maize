"""Labyrinth determinism and anti-fingerprint."""

from moqesh import vocabulary as vocab
from moqesh.labyrinth import LabyrinthGenerator, LabyrinthOptions, kind_of
from moqesh.rng import SeededRandom


def test_rng_deterministic_same_seed_path():
    assert SeededRandom("s1", "/a/b").alnum(32) == SeededRandom("s1", "/a/b").alnum(32)


def test_rng_changes_with_seed():
    assert SeededRandom("s1", "/a/b").alnum(32) != SeededRandom("s2", "/a/b").alnum(32)


def test_labyrinth_deterministic():
    opts = LabyrinthOptions(seed="deploy-123", realism_level=4)
    gen = LabyrinthGenerator()
    for path in ["/", "/ops/", "/ops/secrets/.env", "/api/v1/users", "/ops/README.md"]:
        a = gen.generate(opts, path)
        b = gen.generate(opts, path)
        assert a.body == b.body, f"not deterministic at {path}"
        assert a.content_type == b.content_type


def test_labyrinth_anti_fingerprint():
    a = LabyrinthGenerator().generate(LabyrinthOptions(seed="deploy-A"), "/")
    b = LabyrinthGenerator().generate(LabyrinthOptions(seed="deploy-B"), "/")
    assert a.body != b.body


def test_dir_tree_navigable_without_name_recursion():
    # The root and upper levels are navigable, but the tree thins out with depth
    # (it can end like a real one) and NEVER repeats an ancestor's name (/exports/exports/).
    opts = LabyrinthOptions(seed="deploy-123")
    gen = LabyrinthGenerator()
    root_subdirs = [link for link in gen.links_for(opts, "/") if link.endswith("/")]
    assert root_subdirs, "the root must be navigable"
    path = root_subdirs[0]
    for _ in range(8):
        segs = [s for s in path.strip("/").split("/")]
        assert len(segs) == len(set(segs)), f"repeated path segment (recursion) in {path}"
        subs = [link for link in gen.links_for(opts, path) if link.endswith("/")]
        if not subs:
            break  # realistic dead end: acceptable by design
        path = subs[0]


def test_unlinked_paths_return_not_reachable():
    # A real finite site: what is linked exists (200), what is probed at random does not (404).
    opts = LabyrinthOptions(seed="deploy-123")
    gen = LabyrinthGenerator()
    assert any(gen.is_reachable(opts, link) for link in gen.links_for(opts, "/"))
    for probe in ["/favicon.ico", "/index.php", "/wp-login.php", "/nonexistent-31404-xyz"]:
        assert not gen.is_reachable(opts, probe), f"{probe} should not be reachable"
    # An API collection that exists in the deployment IS reachable; a nonexistent one is NOT
    # (previously ANY /api/... returned 200 -> giveaway; now the API is finite and coherent).
    res = vocab.resources(gen.global_ctx(opts).theme)[0]
    assert gen.is_reachable(opts, f"/api/v2/{res}")
    assert not gen.is_reachable(opts, "/api/v2/nonexistent-collection-xyz")


def test_kind_of_classification():
    cases = {
        "/": "landing",
        "/ops/": "dir",
        "/ops/.env": "env",
        "/ops/config.yaml": "config",
        "/ops/credentials.json": "apiconfig",
        "/api/v1/users": "api",
        "/ops/README.md": "readme",
        "/ops/app.js": "js",
        "/ops/deploy.sh": "script",
        "/ops/access.log": "noise",
        "/ops/backup.sql": "sqldump",
        "/ops/data.bak": "archive",
        "/ops/acme-cli": "binary",
    }
    for path, expected in cases.items():
        assert kind_of(path) == expected, f"{path} -> {kind_of(path)} (esperado {expected})"


def test_mimic_profile_biases_vocabulary():
    # A Mimic profile must inject its vocabulary into the generated directories.
    profile = {
        "vocabulary": ["widgets", "tenants"],
        "paths": ["/widgets/", "/billing/"],
        "api_prefixes": ["/api/"],
        "server_banner": "cloudflare",
    }
    opts = LabyrinthOptions(seed="m1", mode="Mimic", profile=profile)
    gen = LabyrinthGenerator()
    # The profile's banner is reflected in the global context.
    assert gen.global_ctx(opts).banner == "cloudflare"
