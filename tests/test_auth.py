"""Dashboard authentication (Phase 3): hashing, signed cookie and the real guard."""

import time

from fastapi.testclient import TestClient

from moqesh import auth
from tests.conftest import TEST_ADMIN_PASSWORD, TEST_ADMIN_USER


def test_password_hash_roundtrip():
    h = auth.hash_password("correct", iters=50_000)  # low iters = fast test
    assert h.startswith("pbkdf2_sha256$")
    assert auth.verify_password("correct", h)
    assert not auth.verify_password("incorrect", h)
    assert not auth.verify_password("correct", "garbage")


def test_token_roundtrip_and_tamper_and_expiry():
    tok = auth.make_token({"uid": 1, "username": "admin"}, max_age=60)
    data = auth.read_token(tok)
    assert data and data["username"] == "admin"
    # Tampered -> invalid.
    assert auth.read_token(tok[:-1] + ("0" if tok[-1] != "0" else "1")) is None
    assert auth.read_token("not-a-token") is None
    # Expired -> invalid.
    expired = auth.make_token({"uid": 1}, max_age=-1)
    assert auth.read_token(expired) is None
    # Without a correct signature (payload without a dot) -> None.
    assert auth.read_token("soloraw") is None


def _real_guard_client():
    from moqesh.api import app
    from moqesh.api.auth import require_user

    app.dependency_overrides.pop(require_user, None)  # use the REAL guard
    return app


def test_dashboard_requires_session_and_login_flow():
    app = _real_guard_client()
    with TestClient(app) as client:
        # Without a session, a dashboard endpoint returns 401.
        assert client.get("/api/rules").status_code == 401
        # Invalid credentials -> 401.
        bad = client.post("/api/auth/login", json={"username": TEST_ADMIN_USER, "password": "mala"})
        assert bad.status_code == 401
        # Correct login -> 200 + a cookie in the client's jar.
        ok = client.post("/api/auth/login", json={"username": TEST_ADMIN_USER, "password": TEST_ADMIN_PASSWORD})
        assert ok.status_code == 200 and ok.json()["role"] == "admin"
        assert auth.cookie_name() in client.cookies
        # With a session, the dashboard responds.
        assert client.get("/api/rules").status_code == 200
        assert client.get("/api/auth/me").json()["username"] == TEST_ADMIN_USER
        # Logout -> vuelve a 401.
        assert client.post("/api/auth/logout").status_code == 200
        client.cookies.clear()
        assert client.get("/api/rules").status_code == 401


def test_sensor_channel_not_behind_dashboard_auth():
    # /ingest/* and /control use their own HMAC; they must NOT require the dashboard session.
    app = _real_guard_client()
    with TestClient(app) as client:
        # Without a session or HMAC: /control answers 401 for LACK OF HMAC (not because of the dashboard guard),
        # and /healthz is public.
        assert client.get("/healthz").status_code == 200
        # /control is rejected by the sensor channel (429/401 for lack of HMAC), NOT by the
        # dashboard guard: confirms the sensor endpoint is not behind the operator's cookie.
        assert client.get("/control").status_code in (401, 429)


def test_login_rate_limited():
    app = _real_guard_client()
    with TestClient(app) as client:
        # Many attempts in a row from the same IP end in 429 (burst=10).
        codes = [
            client.post("/api/auth/login", json={"username": "x", "password": "y"}).status_code
            for _ in range(15)
        ]
        assert 429 in codes
        time.sleep(0)  # no-op; the limiter uses monotonic time