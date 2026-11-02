"""Local honeypot server (port 8080): the `local` sensor.

Serves the live labyrinth/scenario and delegates logging + scoring to the central
pipeline (`pipeline.score_and_record`), the same one remote sensors use.
Async effects (block webhook, AI confirmation, broadcast) are scheduled on the loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from contextlib import asynccontextmanager
from email.utils import formatdate

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy import select

from . import pipeline
from .ai_analyst import AiConfirmationOptions, build_classifier, confirm_session
from .blocks import BlockService, NotificationOptions
from .config import settings
from .db import SessionLocal, init_db
from .detection import intensity_for
from .labyrinth import LabyrinthGenerator, LabyrinthOptions, effective_api_path, file_mtime_epoch
from .models import AgentSession, HoneypotConfig, Sensor, SessionProgress, utcnow
from .profiles import load_builtin
from .realtime import manager
from .rng import SeededRandom
from .scenarios import ScenarioContext, ScenarioEngine, ScenarioRequest, load_active
from .vocabulary import server_banner
from .world import World, default_world_path, ensure_seeded

logger = logging.getLogger("moqesh.honeypot")
_gen = LabyrinthGenerator()


def _notify_options() -> NotificationOptions:
    return NotificationOptions(
        webhook_url=settings.webhook_url,
        secret=settings.webhook_secret,
        enforce_block=settings.enforce_block,
        auto_block_score=settings.auto_block_score,
        enable_iptables=settings.enable_iptables,
    )


def _ai_options() -> AiConfirmationOptions:
    return AiConfirmationOptions(
        enabled=settings.ai_enabled,
        provider=settings.ai_provider,
        base_url=settings.ai_base_url,
        api_key=settings.ai_api_key,
        model=settings.ai_model,
        gray_zone_low=settings.ai_gray_zone_low,
        gray_zone_high=settings.ai_gray_zone_high,
        confirm_threshold=settings.ai_confirm_threshold,
    )


def _options_from_cfg(cfg: HoneypotConfig, profile: dict | None) -> LabyrinthOptions:
    return LabyrinthOptions(
        mode=cfg.generation_mode,
        seed=cfg.seed or "default-seed",
        realism_level=max(1, min(cfg.realism_level, 5)),
        vocabulary_theme=cfg.vocabulary_theme or "",
        brand_name=cfg.brand_name or "",
        profile=profile,
        allow_infinite=settings.allow_infinite_on_confirmed,
    )


async def _profile_if_mimic(cfg: HoneypotConfig) -> dict | None:
    if cfg.generation_mode != "Mimic" or not cfg.target_url:
        return None
    from .models import SiteProfile

    with SessionLocal() as db:
        existing = db.scalar(
            select(SiteProfile)
            .where(SiteProfile.target_url == cfg.target_url)
            .order_by(SiteProfile.created_at.desc())
            .limit(1)
        )
        if existing:
            try:
                return json.loads(existing.profile_json)
            except ValueError:
                return None
    try:
        from .mimic import profile_site

        logger.info("[Mimic] Perfilando %s…", cfg.target_url)
        data = await profile_site(cfg.target_url, max_pages=12)
        with SessionLocal() as db:
            db.add(SiteProfile(target_url=cfg.target_url, profile_json=json.dumps(data)))
            db.commit()
        return data
    except Exception:
        logger.warning("[Mimic] Could not profile %s; using Template", cfg.target_url, exc_info=True)
        return None


async def _resolve_profile(cfg: HoneypotConfig) -> dict | None:
    """Active labyrinth profile: a selectable built-in (Template/Static with
    `MOQESH_SITE_PROFILE`) or, in Mimic mode, the crawl of the target site."""
    if settings.site_profile and cfg.generation_mode != "Mimic":
        prof = load_builtin(settings.site_profile)
        if prof is not None:
            logger.info("[Perfil] built-in '%s' cargado", settings.site_profile)
            return prof
        logger.warning("[Profile] built-in '%s' not found; generic labyrinth by seed", settings.site_profile)
    return await _profile_if_mimic(cfg)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    manager.bind_loop(asyncio.get_running_loop())
    with SessionLocal() as db:
        cfg = db.get(HoneypotConfig, 1) or db.scalar(select(HoneypotConfig).limit(1))
        local = db.scalar(select(Sensor).where(Sensor.kind == "local").limit(1))
        app.state.local_sensor_id = local.id if local else None
    app.state.profile = await _resolve_profile(cfg)
    app.state.options = _options_from_cfg(cfg, app.state.profile)
    app.state.engine = ScenarioEngine()
    app.state.notify = _notify_options()
    app.state.ai_options = _ai_options()
    app.state.classifier = build_classifier(app.state.ai_options)
    app.state.block_service = BlockService(app.state.notify)
    app.state.honeypot_id = cfg.id
    # World: inert static content (primary source). If empty, seed the curated seed content.
    if settings.world_enabled:
        wpath = settings.world_path or default_world_path(settings.db_path)
        if settings.world_autoseed:
            ensure_seeded(wpath)
        app.state.world = World(wpath)
        if app.state.world.active:
            logger.info("[world] active at %s (%d portal(s))", wpath, len(app.state.world.mounts))
    else:
        app.state.world = None
    yield
    await app.state.block_service.aclose()


class _HeaderCaseMiddleware:
    """Rewrite response header names to Title-Case (Content-Type, Server, ...).

    uvicorn/ASGI emits them in lowercase; a `Server: Microsoft-IIS/10.0` or `nginx` with lowercase
    headers is technically impossible and exposes the stack. A real server (nginx/IIS/Apache)
    sends them capitalized, with special cases like `WWW-Authenticate` and `ETag`.
    """

    _SPECIAL = {
        b"www-authenticate": b"WWW-Authenticate",
        b"etag": b"ETag",
        b"content-md5": b"Content-MD5",
        b"dnt": b"DNT",
        b"x-xss-protection": b"X-XSS-Protection",
    }

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                message["headers"] = [(self._case(k), v) for k, v in message.get("headers", [])]
            await send(message)

        await self.app(scope, receive, send_wrapper)

    @classmethod
    def _case(cls, name: bytes) -> bytes:
        low = name.lower()
        if low in cls._SPECIAL:
            return cls._SPECIAL[low]
        return b"-".join(p[:1].upper() + p[1:] for p in low.split(b"-"))


def _file_meta(seed: str, path: str, size: int) -> tuple[str, str]:
    """Deterministic Last-Modified + ETag for a 'file' (nginx style: mtime-size in hex).

    The mtime is shared with the content generator (`file_mtime_epoch`), so the
    modification date never contradicts what the file documents (e.g. CHANGELOG entries).
    """
    epoch = file_mtime_epoch(seed, path)
    return formatdate(epoch, usegmt=True), f'"{epoch:x}-{size:x}"'


# "Dynamic" node kinds (listings, API, errors): as on a real server, they do NOT carry
# Last-Modified/ETag/Accept-Ranges. Everything else is a 'file' and does.
_DYNAMIC_KINDS = {
    "dir", "landing", "notfound", "blocked", "api", "resource", "scenario:dir", "world-dyn", "world-stream",
}

# docs_url/redoc_url/openapi_url = None: no automatic FastAPI docs. Otherwise
# /openapi.json, /docs and /redoc would reveal the framework and the app title
# (an instant giveaway). With this, those routes fall through to the catch-all and are served as normal lure.
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.add_middleware(_HeaderCaseMiddleware)


def _source_ip(req: Request) -> str:
    xff = req.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return req.client.host if req.client else "unknown"


def _derive_banner(opts: LabyrinthOptions) -> str:
    return server_banner(SeededRandom(opts.seed, "\u0001global"))


def _add_csv(csv: str, value: str) -> str:
    items = {x.strip() for x in (csv or "").split(",") if x.strip()}
    items.add(value)
    return ",".join(sorted(items))


def _forbidden(banner: str) -> bytes:
    return (
        f"<html><head><title>403 Forbidden</title></head><body>\n<center><h1>403 Forbidden</h1></center>\n"
        f"<hr><center>{banner}</center>\n</body></html>"
    ).encode()


def _not_found(banner: str) -> bytes:
    return (
        f"<html><head><title>404 Not Found</title></head><body>\n<center><h1>404 Not Found</h1></center>\n"
        f"<hr><center>{banner}</center>\n</body></html>"
    ).encode()


def scenario_progress_signals(db, sensor_id, scenario, hit, path, session_id, ordered) -> dict[str, bool]:
    """Update SessionProgress with the scenario hit and return the strong signals.

    Reusable by the local honeypot and by agent ingestion (which rebuilds
    a `hit` from the reported facts).
    """
    prog = db.scalar(select(SessionProgress).where(SessionProgress.session_id == session_id).limit(1))
    if prog is None:
        prog = SessionProgress(session_id=session_id, scenario_id=scenario.scenario_id, sensor_id=sensor_id)
        db.add(prog)
        db.flush()
    if hit.is_hidden:
        prog.hidden_hits += 1
    if hit.used_planted_cred_key:
        prog.credentials_used = _add_csv(prog.credentials_used, hit.used_planted_cred_key)
    if hit.failed_auth:
        prog.failed_auth_attempts += 1
    for g in hit.granted_cred_keys:
        prog.credentials_obtained = _add_csv(prog.credentials_obtained, g)
    prog.stage_reached = max(prog.stage_reached, hit.stage)
    node = scenario.node_at(path)
    if node is not None and node.visibility == "hidden" and node.hinted_by_paths:
        for h in (x.strip() for x in node.hinted_by_paths.split(",") if x.strip()):
            hn = scenario.node_at(h)
            if (
                hn is not None
                and hn.kind == "binary"
                and any(p.rstrip("/").lower() == h.rstrip("/").lower() for p in ordered)
            ):
                prog.decompile_follow = True
                break
    prog.updated_at = utcnow()
    return {
        "credential_reuse": bool(prog.credentials_used),
        "hidden_path_access": prog.hidden_hits > 0,
        "binary_decompile_followup": prog.decompile_follow,
        "auth_bruteforce": prog.failed_auth_attempts >= 3,
    }


async def _auto_block(block_service: BlockService, ip: str, reason: str, sid: int, meta: dict) -> None:
    with SessionLocal() as db:
        await block_service.block(db, ip, reason, session_id=sid, source="auto", meta=meta)


async def _ai_confirm(classifier, ai_options: AiConfirmationOptions, sid: int) -> None:
    with SessionLocal() as db:
        s = db.get(AgentSession, sid)
        if s is not None:
            await confirm_session(db, s, classifier, ai_options)


@app.api_route("/{full_path:path}", methods=["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
def catch_all(full_path: str, request: Request) -> Response:
    st = request.app.state
    started = time.perf_counter()
    path = "/" + full_path
    source_ip = _source_ip(request)
    ua = request.headers.get("user-agent", "")
    headers = dict(request.headers)

    with SessionLocal() as db:
        cfg = db.get(HoneypotConfig, st.honeypot_id) or db.scalar(select(HoneypotConfig).limit(1))
        opts: LabyrinthOptions = st.options
        if opts is None or opts.seed != (cfg.seed or "default-seed") or opts.mode != cfg.generation_mode:
            opts = _options_from_cfg(cfg, st.profile)
            st.options = opts

        banner = cfg.server_banner if cfg.server_banner and cfg.server_banner != "nginx" else _derive_banner(opts)
        brand = LabyrinthGenerator.brand_for(opts)
        blocked = st.notify.enforce_block and st.block_service.is_blocked(db, source_ip)

        # Adaptive intensity: derived from the session state AFTER the previous request (score +
        # signals already persisted). Response N scales by what we knew at N-1; no need
        # to score before serving. 0 = unknown/human (real finite site, max stealth).
        sess = db.scalar(
            select(AgentSession)
            .where(
                AgentSession.sensor_id == st.local_sensor_id,
                AgentSession.source_ip == source_ip,
                AgentSession.status == "Active",
            )
            .order_by(AgentSession.last_seen.desc())
            .limit(1)
        )
        intensity = intensity_for(sess)
        # ?page=N -> canonical /page/N, so query pagination is consistent with /page/N.
        eff_path = effective_api_path(path, request.url.query)

        attachment: str | None = None
        node_kind = "static"
        stream_path: str | None = None
        stream_size = 0
        hit = None
        scenario = None

        if blocked:
            body, content_type, status, node_kind = _forbidden(banner), "text/html", 403, "blocked"
        else:
            # The CTF scenario is only served if enabled (per-deployment flag). Otherwise the
            # honeypot presents only the realistic labyrinth (max stealth).
            scenario = load_active(db) if settings.scenarios_enabled else None
            if scenario is not None:
                ctx = ScenarioContext(seed=opts.seed, brand=LabyrinthGenerator.brand_for(opts))
                hit = st.engine.resolve(
                    scenario,
                    ctx,
                    ScenarioRequest(
                        path=path, query=request.url.query or None, headers=headers, cookie=headers.get("cookie")
                    ),
                )
            world = getattr(st, "world", None)
            if hit is not None:
                body, content_type, status = hit.body, hit.content_type, hit.status
                attachment, node_kind = hit.attachment_name, "scenario:" + hit.node_kind
            elif world is not None and world.active:
                # Active World = primary source: serves ONLY bytes of real files (never
                # executes). Anything absent -> real 404 (does not fall back to the labyrinth: mixing real
                # and generated content would reintroduce the giveaways).
                wf = world.resolve(path)
                if wf is not None and wf.stream:
                    # Large file: STREAMING from disk (FileResponse), never in memory.
                    node_kind = "world-stream"
                    stream_path, stream_size = wf.path, wf.size
                    body, content_type, status = b"", wf.content_type, 200
                elif wf is not None:
                    # A dynamic file (Moqesh filled in tokens) is served as an app response
                    # (no ETag/Last-Modified, no-store); a small static one, as a file.
                    node_kind = "world-dyn" if wf.dynamic else "world"
                    body, content_type, status = wf.body, wf.content_type, 200
                else:
                    body, content_type, status, node_kind = _not_found(banner), "text/html", 404, "notfound"
            elif cfg.token_exhaust_enabled and opts.mode != "Static" and _gen.is_reachable(opts, eff_path, intensity):
                page = _gen.generate(opts, eff_path, intensity)
                body, content_type, status = page.body, page.content_type, page.status_code
                attachment, node_kind = page.attachment_name, page.node_kind
            else:
                # Unlinked path (fingerprinter probe) or token-exhaust off -> real 404.
                body, content_type, status, node_kind = _not_found(banner), "text/html", 404, "notfound"

        tarpit = max(0, cfg.tarpit_delay_ms)
        if settings.adaptive_tarpit and intensity > 0:
            # The delay grows with intensity up to tarpit_max_ms (invisible at intensity 0):
            # burns the confirmed agent's wall-clock and tokens without affecting human traffic.
            tarpit = min(settings.tarpit_max_ms, tarpit + intensity * (settings.tarpit_max_ms // 3))
        if tarpit:
            time.sleep(tarpit / 1000.0)
        processing_ms = (time.perf_counter() - started) * 1000.0

        def signals_fn(db_, session_id, ordered):
            if scenario is None or hit is None:
                return {}
            return scenario_progress_signals(db_, st.local_sensor_id, scenario, hit, path, session_id, ordered)

        result = pipeline.score_and_record(
            db,
            sensor_id=st.local_sensor_id,
            opts=opts,
            source_ip=source_ip,
            user_agent=ua,
            method=request.method,
            path=path,
            status=status,
            response_size=stream_size if stream_path else len(body),
            processing_ms=processing_ms,
            node_kind=node_kind,
            query=request.url.query or None,
            headers_json=json.dumps(headers),
            model_attribution=headers.get("x-agent-model"),
            tarpit_ms=tarpit,
            signals_fn=signals_fn,
        )
        db.commit()

    cred_reuse, score, sid = result.cred_reuse, result.score, result.session_id
    if cred_reuse or (st.notify.auto_block_score > 0 and score >= st.notify.auto_block_score):
        reason = (
            "use of a planted credential (confirmed)"
            if cred_reuse
            else f"score {score:.2f} >= threshold {st.notify.auto_block_score:.2f}"
        )
        manager.schedule(
            _auto_block(st.block_service, source_ip, reason, sid, {"score": score, "credentialReuse": cred_reuse})
        )
    if st.ai_options.enabled and st.ai_options.gray_zone_low <= score <= st.ai_options.gray_zone_high:
        manager.schedule(_ai_confirm(st.classifier, st.ai_options, sid))
    manager.publish("request", result.request_dto)
    if result.alert:
        manager.publish("alert", result.alert)

    resp_headers = {"Server": banner, "Date": formatdate(usegmt=True)}
    # Files (not listings/API/errors): like a real server, they carry static-file metadata.
    if status == 200 and node_kind not in _DYNAMIC_KINDS and not node_kind.endswith(":dir"):
        last_mod, etag = _file_meta(opts.seed, path, len(body))
        resp_headers["Last-Modified"] = last_mod
        resp_headers["ETag"] = etag
        resp_headers["Accept-Ranges"] = "bytes"
    # App/security headers on World responses: a real internal app behind nginx
    # carries them (their total absence was a giveaway). Dynamic = no-store; static = cacheable.
    if node_kind in ("world", "world-dyn", "world-stream"):
        resp_headers["X-Request-Id"] = secrets.token_hex(16)
        resp_headers["X-Content-Type-Options"] = "nosniff"
        resp_headers["X-Frame-Options"] = "SAMEORIGIN"
        resp_headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        is_html = content_type.startswith("text/html")
        resp_headers["Cache-Control"] = (
            "no-store" if node_kind == "world-dyn" else ("no-cache" if is_html else "public, max-age=3600")
        )
        if is_html:
            resp_headers["Content-Security-Policy"] = (
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'"
            )
    if attachment:
        resp_headers["Content-Disposition"] = f'attachment; filename="{attachment}"'
    if status == 401:
        resp_headers["WWW-Authenticate"] = f'Bearer realm="{brand}", Basic realm="{brand}"'
    if stream_path is not None:
        # Large file served by streaming: FileResponse sets real Content-Length/ETag/Last-Modified
        # from the file's stat and supports Range (like a real static server).
        return FileResponse(
            stream_path, media_type=content_type.split(";")[0].strip(), status_code=status, headers=resp_headers
        )
    return Response(
        content=body, media_type=content_type.split(";")[0].strip(), status_code=status, headers=resp_headers
    )
