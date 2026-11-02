"""Moqesh remote agent: an edge honeypot with signed control and batched delivery.

Architecture (all in memory, no DB):
  * Local HTTP server (the stdlib's `ThreadingHTTPServer`) that serves the procedural
    labyrinth and the active CTF scenario, exactly like the central honeypot.
  * Control thread: polls `GET /control` with HMAC auth, VERIFIES the server's
    signature on the response and applies the desired state (enabled/seed/scenario).
  * Per-IP in-memory state to compute the 4 cumulative strong signals
    (same logic as `honeypot.scenario_progress_signals`, but without SQLAlchemy).
  * Delivery thread: queues events and sends them in signed batches to `POST /ingest/events`,
    with jitter and a retry buffer (no events lost on network outages).

Contract with the server (fixed; see `moqesh/api/node.py`):
  - Auth on every request: `X-Moqesh-Key-Id`, `X-Moqesh-Timestamp` (= str(time.time())),
    `X-Moqesh-Signature` = `security.sign(secret, ts, body)`. For GET /control body = b"".
  - The /control response is validated with `security.verify(secret, ts, server_sig, body)`.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import random
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

from .. import security
from ..labyrinth import LabyrinthGenerator, LabyrinthOptions
from ..scenarios import (
    ScCred,
    ScenarioContext,
    ScenarioData,
    ScenarioEngine,
    ScenarioRequest,
    ScenarioResult,
    ScNode,
)

AGENT_VERSION = "0.1.0"
STRONG_KEYS = ("credential_reuse", "hidden_path_access", "binary_decompile_followup", "auth_bruteforce")
_DEFAULT_SEED = "default-seed"

logger = logging.getLogger("moqesh.agent")


# ----------------------------- configuration --------------------------------


@dataclass
class AgentConfig:
    """Agent config read from the environment (does NOT use `moqesh.config`/pydantic-settings)."""

    server: str
    key_id: str
    secret: str
    port: int = 8080
    control_interval: float = 30.0
    beacon_jitter: float = 0.3

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> AgentConfig:
        env = env if env is not None else dict(os.environ)
        server = (env.get("MOQESH_SERVER") or "").rstrip("/")
        key_id = env.get("MOQESH_KEY_ID") or ""
        secret = env.get("MOQESH_SECRET") or ""
        required = (("MOQESH_SERVER", server), ("MOQESH_KEY_ID", key_id), ("MOQESH_SECRET", secret))
        missing = [name for name, value in required if not value]
        if missing:
            raise ValueError("missing required environment variables: " + ", ".join(missing))
        return cls(
            server=server,
            key_id=key_id,
            secret=secret,
            port=int(env.get("MOQESH_AGENT_PORT") or 8080),
            control_interval=float(env.get("MOQESH_CONTROL_INTERVAL") or 30.0),
            beacon_jitter=float(env.get("MOQESH_BEACON_JITTER") or 0.3),
        )


# ----------------------------- strong signals (pure, testable) ---------------


@dataclass
class IpProgress:
    """Cumulative per-IP progress (in-memory mirror of `SessionProgress`)."""

    scenario_id: int = 0
    hidden_hits: int = 0
    failed_auth_attempts: int = 0
    stage_reached: int = 0
    decompile_follow: bool = False
    credentials_used: set[str] = field(default_factory=set)
    credentials_obtained: set[str] = field(default_factory=set)
    paths: list[str] = field(default_factory=list)  # ordered path history


def update_progress(prog: IpProgress, scenario: ScenarioData, hit: ScenarioResult, path: str) -> dict[str, bool]:
    """Apply the scenario `hit` to the in-memory progress and return the 4 strong signals.

    Exact replica of `honeypot.scenario_progress_signals` without a DB: the `ordered` there is
    `prog.paths` here (the current path already included, same as the freshly inserted RequestLog).
    """
    prog.paths.append(path)
    if hit.is_hidden:
        prog.hidden_hits += 1
    if hit.used_planted_cred_key:
        prog.credentials_used.add(hit.used_planted_cred_key)
    if hit.failed_auth:
        prog.failed_auth_attempts += 1
    for g in hit.granted_cred_keys:
        prog.credentials_obtained.add(g)
    prog.stage_reached = max(prog.stage_reached, hit.stage)

    node = scenario.node_at(path)
    if node is not None and node.visibility == "hidden" and node.hinted_by_paths:
        for h in (x.strip() for x in node.hinted_by_paths.split(",") if x.strip()):
            hn = scenario.node_at(h)
            if (
                hn is not None
                and hn.kind == "binary"
                and any(p.rstrip("/").lower() == h.rstrip("/").lower() for p in prog.paths)
            ):
                prog.decompile_follow = True
                break

    return {
        "credential_reuse": bool(prog.credentials_used),
        "hidden_path_access": prog.hidden_hits > 0,
        "binary_decompile_followup": prog.decompile_follow,
        "auth_bruteforce": prog.failed_auth_attempts >= 3,
    }


def progress_facts(prog: IpProgress) -> dict:
    """Cumulative progress snapshot for the event payload (sorted CSV, deterministic)."""
    return {
        "stage_reached": prog.stage_reached,
        "credentials_obtained": ",".join(sorted(prog.credentials_obtained)),
        "credentials_used": ",".join(sorted(prog.credentials_used)),
        "hidden_hits": prog.hidden_hits,
        "decompile_follow": prog.decompile_follow,
        "failed_auth_attempts": prog.failed_auth_attempts,
        "scenario_id": prog.scenario_id,
    }


def build_event(
    *,
    source_ip: str,
    method: str,
    path: str,
    query: str | None,
    user_agent: str,
    status: int,
    size: int,
    processing_ms: float,
    node_kind: str,
    model_attribution: str | None,
    strong: dict[str, bool],
    progress: dict | None,
) -> dict:
    """Build the event according to the `POST /ingest/events` contract."""
    ev: dict = {
        "source_ip": source_ip,
        "method": method,
        "path": path,
        "user_agent": user_agent,
        "status": status,
        "size": size,
        "processing_ms": processing_ms,
        "node_kind": node_kind,
        "strong": {k: bool(strong.get(k, False)) for k in STRONG_KEYS},
    }
    if query:
        ev["query"] = query
    if model_attribution:
        ev["model_attribution"] = model_attribution
    if progress is not None:
        ev["progress"] = progress
    return ev


# ----------------------------- scenario reconstruction -----------------------


def build_scenario(pack: dict, scenario_id: int) -> ScenarioData:
    """Rebuild `ScenarioData` from the pack dict (camelCase -> snake_case)."""
    nodes = [
        ScNode(
            id=i,
            path=n["path"],
            visibility=n.get("visibility", "linked"),
            kind=n.get("kind", "file"),
            content_type=n.get("contentType") or "text/plain; charset=utf-8",
            body_template=n.get("bodyTemplate", ""),
            requires_credential_key=n.get("requiresCredentialKey"),
            grants_credential_keys=n.get("grantsCredentialKeys"),
            hinted_by_paths=n.get("hintedByPaths"),
            stage=n.get("stage", 0),
            binary_kind=n.get("binaryKind", "none"),
            binary_secret=n.get("binarySecret", ""),
        )
        for i, n in enumerate(pack.get("nodes", []))
    ]
    creds = [
        ScCred(
            key=c["key"],
            username=c.get("username"),
            secret=c.get("secret", ""),
            kind=c.get("kind", "bearer"),
            found_in_path=c.get("foundInPath"),
            usable_at_path=c.get("usableAtPath"),
        )
        for c in pack.get("credentials", [])
    ]
    return ScenarioData(scenario_id=scenario_id, name=pack.get("name", ""), nodes=nodes, credentials=creds)


# ----------------------------- server client (httpx) ------------------------


class ServerClient:
    """HMAC client to the central server (healthz / control / ingest)."""

    def __init__(self, server: str, key_id: str, secret: str, *, timeout: float = 10.0) -> None:
        self._base = server.rstrip("/")
        self._key_id = key_id
        self._secret = secret
        self._client = httpx.Client(timeout=timeout)

    def _auth_headers(self, body: bytes) -> dict[str, str]:
        ts = str(time.time())
        return {
            "X-Moqesh-Key-Id": self._key_id,
            "X-Moqesh-Timestamp": ts,
            "X-Moqesh-Signature": security.sign(self._secret, ts, body),
        }

    def healthz(self) -> bool:
        try:
            return self._client.get(f"{self._base}/healthz").status_code == 200
        except httpx.HTTPError as exc:
            logger.warning("healthz: network error: %s", exc)
            return False

    def get_control(self) -> dict | None:
        """Return the control payload only if the server's signature is valid."""
        try:
            r = self._client.get(f"{self._base}/control", headers=self._auth_headers(b""))
        except httpx.HTTPError as exc:
            logger.warning("control: network error: %s", exc)
            return None
        if r.status_code != 200:
            logger.warning("control: HTTP response %s", r.status_code)
            return None
        ts = r.headers.get("X-Moqesh-Timestamp", "")
        sig = r.headers.get("X-Moqesh-Server-Signature", "")
        if not security.verify(self._secret, ts, sig, r.content):
            logger.error("control: INVALID server signature; ignoring the response")
            return None
        try:
            return r.json()
        except ValueError:
            logger.error("control: invalid JSON")
            return None

    def post_events(self, events: list[dict]) -> bool:
        """Send a signed batch. Returns False on any failure (the caller retries)."""
        body = json.dumps({"agent_version": AGENT_VERSION, "events": events}).encode()
        try:
            r = self._client.post(f"{self._base}/ingest/events", content=body, headers=self._auth_headers(body))
        except httpx.HTTPError as exc:
            logger.warning("ingest: network error (%d events held): %s", len(events), exc)
            return False
        if r.status_code == 200:
            return True
        logger.warning("ingest: HTTP response %s (%d events held)", r.status_code, len(events))
        return False

    def close(self) -> None:
        self._client.close()


# ----------------------------- background threads ---------------------------


def _jittered(interval: float, jitter: float) -> float:
    """Interval with symmetric jitter (±jitter) to blur the beacon pattern."""
    if jitter <= 0:
        return max(0.0, interval)
    return max(0.0, interval * (1.0 + random.uniform(-jitter, jitter)))


class ControlLoop(threading.Thread):
    """Poll /control periodically and apply the state to the agent."""

    def __init__(self, agent: Agent, client: ServerClient, interval: float, jitter: float) -> None:
        super().__init__(name="moqesh-control", daemon=True)
        self._agent = agent
        self._client = client
        self._interval = interval
        self._jitter = jitter
        self._stop = threading.Event()

    def run(self) -> None:
        while not self._stop.is_set():
            data = self._client.get_control()
            if data is not None:
                self._agent.apply_control(data)
            self._stop.wait(_jittered(self._interval, self._jitter))

    def stop(self) -> None:
        self._stop.set()


class EventSender(threading.Thread):
    """Send events in batches with jitter; keeps a (bounded) retry buffer."""

    def __init__(self, client: ServerClient, interval: float, jitter: float, *, max_buffer: int = 50_000) -> None:
        super().__init__(name="moqesh-sender", daemon=True)
        self._client = client
        self._interval = interval
        self._jitter = jitter
        self._max_buffer = max_buffer
        self._queue: queue.Queue[dict] = queue.Queue()
        self._pending: list[dict] = []  # events that could not be sent
        self._stop = threading.Event()

    def enqueue(self, event: dict) -> None:
        self._queue.put(event)

    def run(self) -> None:
        while not self._stop.is_set():
            self._stop.wait(_jittered(self._interval, self._jitter))
            self._flush()
        self._flush()  # last attempt on shutdown

    def _drain(self) -> list[dict]:
        batch = list(self._pending)
        self._pending = []
        while True:
            try:
                batch.append(self._queue.get_nowait())
            except queue.Empty:
                break
        return batch

    def _flush(self) -> None:
        batch = self._drain()
        if not batch:
            return
        if not self._client.post_events(batch):
            # Retry next cycle: keep the most recent ones (memory cap).
            self._pending = batch[-self._max_buffer :]

    def stop(self) -> None:
        self._stop.set()


# ----------------------------- honeypot server ------------------------------


class _HoneypotServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    agent: Agent | None = None


class _Handler(BaseHTTPRequestHandler):
    """Delegate every method to the agent; silence the default logging."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args: object) -> None:  # noqa: D102 - silencio intencional
        pass

    def _dispatch(self) -> None:
        server: _HoneypotServer = self.server  # type: ignore[assignment]
        if server.agent is not None:
            server.agent.handle_request(self)

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _dispatch


# ----------------------------- agent -----------------------------------------


class Agent:
    """Orchestrates the local honeypot + signed control + batched delivery."""

    def __init__(self, cfg: AgentConfig, client: ServerClient | None = None) -> None:
        self._cfg = cfg
        self._client = client or ServerClient(cfg.server, cfg.key_id, cfg.secret)
        self._gen = LabyrinthGenerator()
        self._engine = ScenarioEngine()

        # Control state (lock-protected; written by the control thread).
        self._state_lock = threading.Lock()
        self._enabled = False  # 404 to everything by default until the first valid control
        self._generation_mode = "Template"
        self._opts = LabyrinthOptions(mode="Template", seed=_DEFAULT_SEED, realism_level=3)
        self._brand = LabyrinthGenerator.brand_for(self._opts)
        self._scenario: ScenarioData | None = None
        self._scenario_id = 0

        # Per-IP progress (protected by its own lock).
        self._prog_lock = threading.Lock()
        self._ip_progress: dict[str, IpProgress] = {}

        self._control = ControlLoop(self, self._client, cfg.control_interval, cfg.beacon_jitter)
        self._sender = EventSender(self._client, cfg.control_interval, cfg.beacon_jitter)

    # ---- control ----

    def apply_control(self, data: dict) -> None:
        """Apply the server's desired state (already verified by the client)."""
        seed = data.get("seed") or _DEFAULT_SEED
        realism = max(1, min(int(data.get("realism_level") or 3), 5))
        # The agent does not profile sites (Mimic), so it always generates in Template mode;
        # "Static" is honored: it serves 404 outside the scenario.
        mode = data.get("generation_mode") or "Template"
        new_sid = int(data.get("scenario_id") or 0)
        pack = data.get("scenario")
        scenario = build_scenario(pack, new_sid) if pack else None
        opts = LabyrinthOptions(mode="Template", seed=seed, realism_level=realism)
        brand = LabyrinthGenerator.brand_for(opts)

        with self._state_lock:
            self._enabled = bool(data.get("enabled", False))
            self._opts = opts
            self._brand = brand
            self._generation_mode = mode
            self._scenario = scenario
            scenario_changed = new_sid != self._scenario_id
            self._scenario_id = new_sid
        if scenario_changed:
            with self._prog_lock:
                self._ip_progress.clear()  # the scenario changed: previous progress is invalid
        logger.info("control applied: enabled=%s seed=%s scenario_id=%s", self._enabled, seed, new_sid)

    def _snapshot(self) -> tuple[bool, LabyrinthOptions, str, ScenarioData | None, str]:
        with self._state_lock:
            return self._enabled, self._opts, self._brand, self._scenario, self._generation_mode

    # ---- request handling ----

    @staticmethod
    def _source_ip(handler: BaseHTTPRequestHandler, headers: dict[str, str]) -> str:
        xff = headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
        return handler.client_address[0] if handler.client_address else "unknown"

    def handle_request(self, handler: BaseHTTPRequestHandler) -> None:
        started = time.perf_counter()
        raw = handler.path or "/"
        path, _, query = raw.partition("?")
        path = path or "/"
        if not path.startswith("/"):
            path = "/" + path
        query = query or None
        headers = {k.lower(): v for k, v in handler.headers.items()}

        # Drain the body (unused, but leaves the connection clean for keep-alive).
        clen = int(headers.get("content-length") or 0)
        if clen > 0:
            try:
                handler.rfile.read(clen)
            except OSError:
                pass

        source_ip = self._source_ip(handler, headers)
        ua = headers.get("user-agent", "")
        enabled, opts, brand, scenario, mode = self._snapshot()

        attachment: str | None = None
        hit: ScenarioResult | None = None
        if not enabled:
            body, content_type, status, node_kind = _NOT_FOUND, "text/html; charset=utf-8", 404, "disabled"
        else:
            if scenario is not None:
                ctx = ScenarioContext(seed=opts.seed, brand=brand)
                req = ScenarioRequest(path=path, query=query, headers=headers, cookie=headers.get("cookie"))
                hit = self._engine.resolve(scenario, ctx, req)
            if hit is not None:
                body, content_type, status = hit.body, hit.content_type, hit.status
                attachment, node_kind = hit.attachment_name, "scenario:" + hit.node_kind
            elif mode != "Static":
                page = self._gen.generate(opts, path)
                body, content_type, status = page.body, page.content_type, page.status_code
                attachment, node_kind = page.attachment_name, page.node_kind
            else:
                body, content_type, status, node_kind = _NOT_FOUND, "text/html; charset=utf-8", 404, "notfound"

        # Cumulative strong signals (only when a scenario resolved).
        strong: dict[str, bool] = {}
        facts: dict | None = None
        if enabled and scenario is not None and hit is not None:
            with self._prog_lock:
                prog = self._ip_progress.get(source_ip)
                if prog is None:
                    prog = IpProgress(scenario_id=scenario.scenario_id)
                    self._ip_progress[source_ip] = prog
                strong = update_progress(prog, scenario, hit, path)
                facts = progress_facts(prog)

        processing_ms = (time.perf_counter() - started) * 1000.0
        self._sender.enqueue(
            build_event(
                source_ip=source_ip,
                method=handler.command,
                path=path,
                query=query,
                user_agent=ua,
                status=status,
                size=len(body),
                processing_ms=processing_ms,
                node_kind=node_kind,
                model_attribution=headers.get("x-agent-model"),
                strong=strong,
                progress=facts,
            )
        )
        self._write(handler, status, content_type, body, attachment, brand)

    @staticmethod
    def _write(
        handler: BaseHTTPRequestHandler,
        status: int,
        content_type: str,
        body: bytes,
        attachment: str | None,
        banner: str,
    ) -> None:
        head_only = handler.command == "HEAD"
        try:
            handler.send_response_only(status)
            handler.send_header("Server", banner)
            handler.send_header("Date", handler.date_time_string())
            handler.send_header("Content-Type", content_type)
            handler.send_header("Content-Length", str(len(body)))
            if attachment:
                handler.send_header("Content-Disposition", f'attachment; filename="{attachment}"')
            if status == 401:
                handler.send_header("WWW-Authenticate", f'Bearer realm="{banner}", Basic realm="internal"')
            handler.end_headers()
            if not head_only:
                handler.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---- lifecycle ----

    def _preflight(self, retries: int = 8) -> None:
        """Preflight against /healthz; logs and retries with backoff, but never blocks startup."""
        delay = 1.0
        for attempt in range(1, retries + 1):
            if self._client.healthz():
                logger.info("preflight OK: %s alcanzable", self._cfg.server)
                return
            logger.warning("preflight: %s inalcanzable (intento %d/%d)", self._cfg.server, attempt, retries)
            time.sleep(min(delay, 30.0))
            delay *= 2
        logger.warning("preflight exhausted; starting anyway (events are buffered)")

    def run(self) -> None:
        self._preflight()
        initial = self._client.get_control()
        if initial is not None:
            self.apply_control(initial)
        self._control.start()
        self._sender.start()
        httpd = _HoneypotServer(("0.0.0.0", self._cfg.port), _Handler)  # noqa: S104 - honeypot: listens publicly on purpose
        httpd.agent = self
        logger.info("honeypot listening on 0.0.0.0:%d", self._cfg.port)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            logger.info("stopping agent...")
        finally:
            self._control.stop()
            self._sender.stop()
            httpd.shutdown()
            self._client.close()


_NOT_FOUND = (
    b"<html><head><title>404 Not Found</title></head><body>\n"
    b"<center><h1>404 Not Found</h1></center>\n<hr></body></html>"
)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        cfg = AgentConfig.from_env()
    except ValueError as exc:
        logger.error("invalid configuration: %s", exc)
        return 2
    Agent(cfg).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
