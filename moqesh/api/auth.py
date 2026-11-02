"""Dashboard authentication: login/logout/me + the `require_user` dependency.

Protects the dashboard routers (`/api/*`) with a signed cookie session.
Does NOT touch the sensor channel (`/ingest/*`, `/control`, `/s/*`, `/download/*`,
`/healthz`), which keeps its own HMAC authentication.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import auth
from ..config import settings
from ..db import get_session
from ..models import User
from ..security import RateLimiter

router = APIRouter(prefix="/auth", tags=["auth"])

# Per-IP login rate limit (anti brute force): ~20/min, burst 10.
_login_limiter = RateLimiter(per_minute=20, burst=10)


class LoginBody(BaseModel):
    username: str
    password: str


def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def require_user(request: Request) -> dict:
    """Guard dependency: requires a valid session or returns 401."""
    data = auth.read_token(request.cookies.get(auth.cookie_name()))
    if data is None:
        raise HTTPException(status_code=401, detail="no autenticado")
    return data


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response, db: Session = Depends(get_session)) -> dict:
    if not _login_limiter.allow(_client_ip(request)):
        raise HTTPException(status_code=429, detail="too many attempts; wait a moment")
    user = db.scalar(select(User).where(User.username == body.username).limit(1))
    # ALWAYS verify (even with no user, against a decoy hash with real iterations)
    # so timing does not leak whether the user exists.
    stored = user.password_hash if user else auth.dummy_hash()
    if not auth.verify_password(body.password, stored) or user is None:
        raise HTTPException(status_code=401, detail="invalid credentials")
    auth.touch_last_login(db, user)
    token = auth.make_token({"uid": user.id, "username": user.username, "role": user.role},
                            max_age=settings.session_max_age)
    response.set_cookie(
        auth.cookie_name(),
        token,
        max_age=settings.session_max_age,
        httponly=True,
        samesite="strict",
        secure=settings.cookie_secure,
        path="/",
    )
    return {"username": user.username, "role": user.role}


@router.post("/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(auth.cookie_name(), path="/")
    return {"ok": True}


@router.get("/me")
def me(user: dict = Depends(require_user)) -> dict:
    return {"username": user.get("username"), "role": user.get("role")}
