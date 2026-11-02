"""Central detection pipeline (a single source of truth).

Used alike by the local honeypot and the remote ingestion endpoints: given an
observed request (served locally or reported by a sensor), it manages the
session by `(sensor_id, source_ip)`, records the `RequestLog`, scores it with the
behavioral rules (+ scenario signals) and raises the alert. The async
effects (block webhook, AI confirmation, broadcast) are decided by the caller.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import detection
from .config import settings
from .labyrinth import LabyrinthGenerator, LabyrinthOptions
from .models import AgentSession, Alert, DetectionRule, RequestLog, utcnow

_gen = LabyrinthGenerator()

# Signature: (db, session_id, ordered_paths) -> dict[strong_rule -> bool].
SignalsFn = Callable[[Session, int, list[str]], dict[str, bool]]


@dataclass
class PipelineResult:
    session_id: int
    score: float
    matched: str
    cred_reuse: bool
    alert: dict | None
    request_dto: dict


def score_and_record(
    db: Session,
    *,
    sensor_id: int,
    opts: LabyrinthOptions,
    source_ip: str,
    user_agent: str,
    method: str,
    path: str,
    status: int,
    response_size: int,
    processing_ms: float,
    node_kind: str,
    query: str | None = None,
    headers_json: str | None = None,
    model_attribution: str | None = None,
    tarpit_ms: int = 0,
    timestamp: datetime | None = None,
    signals_fn: SignalsFn | None = None,
) -> PipelineResult:
    ts = timestamp or utcnow()

    session = db.scalar(
        select(AgentSession)
        .where(
            AgentSession.sensor_id == sensor_id,
            AgentSession.source_ip == source_ip,
            AgentSession.status == "Active",
        )
        .order_by(AgentSession.last_seen.desc())
        .limit(1)
    )
    if session is None:
        session = AgentSession(
            sensor_id=sensor_id, source_ip=source_ip, user_agent=user_agent, first_seen=ts, last_seen=ts
        )
        db.add(session)
        db.flush()

    session.last_seen = ts
    session.request_count += 1
    session.nodes_served += 1
    session.time_wasted_ms += int(processing_ms) + tarpit_ms
    if user_agent:
        session.user_agent = user_agent
    if model_attribution:
        session.model_attribution = model_attribution

    db.add(
        RequestLog(
            sensor_id=sensor_id,
            honeypot_id=1,
            session_id=session.id,
            timestamp=ts,
            source_ip=source_ip,
            method=method,
            path=path,
            query_string=query,
            headers=headers_json,
            user_agent=user_agent,
            response_code=status,
            response_size=response_size,
            processing_time_ms=processing_ms,
        )
    )
    db.flush()

    rows = db.execute(
        select(RequestLog.path, RequestLog.timestamp)
        .where(RequestLog.session_id == session.id)
        .order_by(RequestLog.timestamp)
    ).all()
    ordered = [r[0] for r in rows]
    timestamps = [r[1] for r in rows]

    extra = signals_fn(db, session.id, ordered) if signals_fn else {}

    rules = list(db.scalars(select(DetectionRule).where(DetectionRule.is_active.is_(True))))
    score, matched = detection.score_session(_gen, opts, rules, ordered, timestamps, user_agent, extra)
    session.ai_probability_score = score
    session.matched_rules = ",".join(matched)
    session.tokens_estimated += detection.estimate_tokens(response_size)
    session.max_depth_reached = max(session.max_depth_reached, path.count("/"))

    alert_dto = None
    if score >= settings.alert_score_threshold and session.request_count >= settings.alert_min_requests:
        open_alert = db.scalar(
            select(Alert.id).where(Alert.session_id == session.id, Alert.acknowledged_at.is_(None)).limit(1)
        )
        if open_alert is None:
            severity = "Critical" if score >= 0.8 else "High" if score >= 0.6 else "Medium" if score >= 0.4 else "Low"
            alert = Alert(
                session_id=session.id,
                sensor_id=sensor_id,
                severity=severity,
                title=f"Possible AI agent detected from {source_ip}",
                description=(
                    f"Score: {score:.2f}. Rules: {session.matched_rules}. "
                    f"Requests: {session.request_count}. "
                    f"Estimated tokens burned: {session.tokens_estimated}."
                ),
                triggered_rules=session.matched_rules,
            )
            db.add(alert)
            db.flush()
            alert_dto = {
                "id": alert.id,
                "severity": alert.severity,
                "title": alert.title,
                "createdAt": utcnow().isoformat() + "Z",
                "acknowledged": False,
                "sensorId": sensor_id,
            }

    req_dto = {
        "id": session.id,
        "sensorId": sensor_id,
        "sourceIp": source_ip,
        "method": method,
        "path": path,
        "responseCode": status,
        "aiProbabilityScore": score,
        "nodeKind": node_kind,
    }

    return PipelineResult(
        session_id=session.id,
        score=score,
        matched=session.matched_rules or "",
        cred_reuse=extra.get("credential_reuse", False),
        alert=alert_dto,
        request_dto=req_dto,
    )
