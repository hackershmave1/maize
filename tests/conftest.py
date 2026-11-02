"""Test configuration: an isolated temporary DB before importing moqesh."""

import os
import tempfile

import pytest

# Config is read when moqesh.config is imported, so we set the environment BEFORE that.
# The prefix is MOQESH_ and the db_path field -> the MOQESH_DB_PATH variable.
_tmp = tempfile.mkdtemp(prefix="moqesh-test-")
os.environ["MOQESH_DB_PATH"] = os.path.join(_tmp, "test.db")
os.environ["MOQESH_AI_ENABLED"] = "false"
os.environ["MOQESH_ENFORCE_BLOCK"] = "false"
# World disabled by default in tests: that way the honeypot tests keep exercising the
# legacy labyrinth. The World is tested separately (tests/test_world.py) by mounting it explicitly.
os.environ["MOQESH_WORLD_ENABLED"] = "false"
# Test admin with a known password (otherwise bootstrap_admin generates a random one).
os.environ["MOQESH_ADMIN_PASSWORD"] = "test-admin-pw"

TEST_ADMIN_USER = "admin"
TEST_ADMIN_PASSWORD = "test-admin-pw"


@pytest.fixture(autouse=True)
def _auth_bypass():
    """Disable the dashboard session guard in tests (the API is tested without login).

    The authentication tests remove this override to exercise the REAL guard:
        app.dependency_overrides.pop(require_user, None)
    """
    from moqesh.api import app
    from moqesh.api.auth import require_user

    app.dependency_overrides[require_user] = lambda: {"username": "test", "role": "admin", "uid": 0}
    yield
    app.dependency_overrides.pop(require_user, None)
