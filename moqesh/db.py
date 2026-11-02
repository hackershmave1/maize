"""Data layer: SQLite engine + sessions + initialization/seed.

Synchronous on purpose (SQLite). FastAPI `def` endpoints run in its
threadpool, so each request uses its own `Session`. Outbound HTTP
(mimic, LLM, webhooks) is async and lives in other modules.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .models import Base, DetectionRule, HoneypotConfig, Sensor

_engine = create_engine(
    f"sqlite:///{os.path.abspath(settings.db_path)}",
    future=True,
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(bind=_engine, class_=Session, expire_on_commit=False, future=True)


def get_session() -> Iterator[Session]:
    """FastAPI dependency: yields a Session and closes it when done."""
    with SessionLocal() as s:
        yield s


# 14 behavioral/CTF rules (the 4 strong ones are fed by the scenario engine).
_SEED_RULES = [
    (1, "Intermediate timing", "Inter-request intervals 2-30s; the LLM pauses to reason.", 0.15, "timing_analysis"),
    (2, "Predictable sequence", "Sequential access to every file (curl->file->exec).", 0.25, "sequence_pattern"),
    (3, "Exhaustive download", "Downloads ALL listed files indiscriminately.", 0.15, "download_pattern"),
    (4, "Literal README", "Runs the README's commands verbatim, in order.", 0.20, "readme_following"),
    (5, "JS deobfuscation", "Hits endpoints only visible by deobfuscating JS.", 0.10, "js_deobfuscation"),
    (6, "User-Agent / headers", "Known User-Agents of AI crawlers/clients.", 0.05, "user_agent"),
    (
        7,
        "Breadcrumb following",
        "Follows the chain of generated links ever deeper.",
        0.10,
        "breadcrumb_following",
    ),
    (8, "Deep descent", "Goes down 5+ levels following configs/.env (not human).", 0.15, "depth_descent"),
    (
        9,
        "Exhaustive fan-out",
        "Follows nearly every link on each page (~total coverage).",
        0.15,
        "exhaustive_fanout",
    ),
    (10, "No asset rendering", "Never requests CSS/JS/img/favicon: there is no browser.", 0.10, "no_asset_render"),
    (
        11,
        "Credential reuse",
        "Presented a planted honeytoken at a gate: near certainty.",
        0.35,
        "credential_reuse",
    ),
    (12, "Hidden path access", "Accessed an unlinked path (hints/fuzzing).", 0.20, "hidden_path_access"),
    (
        13,
        "Decompilation follow-up",
        "Downloaded a binary and followed a path embedded in it.",
        0.20,
        "binary_decompile_followup",
    ),
    (14, "Auth brute force", "Multiple failed attempts against a gate.", 0.10, "auth_bruteforce"),
]


def init_db() -> None:
    """Create the schema and seed rules, the default honeypot and the built-in scenario."""
    Base.metadata.create_all(_engine)
    with SessionLocal() as s:
        if s.scalar(select(DetectionRule).limit(1)) is None:
            s.add_all(
                DetectionRule(id=i, name=n, description=d, weight=w, rule_type=rt, is_active=True)
                for (i, n, d, w, rt) in _SEED_RULES
            )
        seed = settings.seed or uuid.uuid4().hex
        if s.scalar(select(HoneypotConfig).limit(1)) is None:
            s.add(
                HoneypotConfig(
                    id=1,
                    name="Honeypot Web Server",
                    type="HTTP",
                    port=settings.honeypot_port,
                    is_active=True,
                    token_exhaust_enabled=settings.token_exhaust_enabled,
                    generation_mode=settings.generation_mode,
                    seed=seed,
                    target_url=settings.target_url,
                    realism_level=max(1, min(settings.realism_level, 5)),
                    tarpit_delay_ms=settings.tarpit_delay_ms,
                    server_banner=settings.server_banner,
                    vocabulary_theme=settings.vocabulary_theme,
                    brand_name=settings.brand_name,
                )
            )
        # `local` sensor: the honeypot itself seen as a sensor (same seed).
        if s.scalar(select(Sensor).where(Sensor.kind == "local").limit(1)) is None:
            s.add(
                Sensor(
                    name="local",
                    kind="local",
                    enabled=True,
                    status="online",
                    seed=seed,
                    generation_mode=settings.generation_mode,
                    realism_level=max(1, min(settings.realism_level, 5)),
                    vocabulary_theme=settings.vocabulary_theme,
                    brand_name=settings.brand_name,
                    covered_url=f"http://localhost:{settings.honeypot_port}",
                    covered_app="honeypot local",
                    base_path="/",
                )
            )
        s.commit()

    # Seed the built-in CTF scenario (deferred import: avoids an import cycle).
    from .scenarios import seed_builtin

    with SessionLocal() as s:
        seed_builtin(s)
