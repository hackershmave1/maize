"""OPTIONAL module for confirming AI agents in the gray zone.

The rule-based detection system (`detection.py`) works autonomously and
assigns each session a 0..1 score. Sessions with an intermediate score (gray zone)
are ambiguous: here we review them once more, with a classifier that can be
purely heuristic (no tokens, no network) or backed by an LLM compatible with the
OpenAI API (OpenRouter, a local endpoint, etc.). If the LLM is unavailable or
fails, it degrades gracefully to the heuristic: the module NEVER blocks the
pipeline and is safe to run without configuring any key.

Behavioral reference: `Moqesh.AiAnalyst` (C#).

Environment variables equivalent to `AiConfirmationOptions` (see `from_env`):
    MOQESH_AI_ENABLED          -> enabled          ("1"/"true"/"yes" = True)
    MOQESH_AI_PROVIDER         -> provider         ("heuristic" | "openai")
    MOQESH_AI_BASE_URL         -> base_url         (e.g. https://openrouter.ai/api/v1)
    MOQESH_AI_API_KEY          -> api_key          (never hardcode secrets)
    MOQESH_AI_MODEL            -> model            (e.g. anthropic/claude-3.5-haiku)
    MOQESH_AI_GRAY_ZONE_LOW    -> gray_zone_low    (default 0.35)
    MOQESH_AI_GRAY_ZONE_HIGH   -> gray_zone_high   (default 0.65)
    MOQESH_AI_CONFIRM_THRESHOLD-> confirm_threshold(default 0.70)
"""

from __future__ import annotations

import json
import logging
import math
import os
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import AgentSession, RequestLog

log = logging.getLogger(__name__)

# LLM call timeout; when it expires we fall back to the heuristic.
_LLM_TIMEOUT_S = 30.0
# How many requests to include in the prompt, to bound token usage.
_MAX_BEATS_IN_PROMPT = 30


def _as_bool(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(slots=True)
class AiConfirmationOptions:
    """Confirmation module config. Safe defaults (heuristic)."""

    enabled: bool = False
    provider: str = "heuristic"  # "heuristic" | "openai"
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    gray_zone_low: float = 0.35  # only sessions in [low, high] are analyzed
    gray_zone_high: float = 0.65
    confirm_threshold: float = 0.7  # minimum confidence to set a verdict

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> AiConfirmationOptions:
        """Build the options from environment variables (see the module docstring)."""
        e = env if env is not None else os.environ
        o = cls()
        o.enabled = _as_bool(e.get("MOQESH_AI_ENABLED", ""))
        o.provider = e.get("MOQESH_AI_PROVIDER", o.provider)
        o.base_url = e.get("MOQESH_AI_BASE_URL", o.base_url)
        o.api_key = e.get("MOQESH_AI_API_KEY", o.api_key)
        o.model = e.get("MOQESH_AI_MODEL", o.model)
        o.gray_zone_low = float(e.get("MOQESH_AI_GRAY_ZONE_LOW", o.gray_zone_low))
        o.gray_zone_high = float(e.get("MOQESH_AI_GRAY_ZONE_HIGH", o.gray_zone_high))
        o.confirm_threshold = float(e.get("MOQESH_AI_CONFIRM_THRESHOLD", o.confirm_threshold))
        return o


@dataclass(slots=True)
class Verdict:
    """The classifier's judgment about a session."""

    is_ai: bool
    confidence: float  # 0..1
    reasoning: str
    model_attribution: str | None = None  # None for heuristic; e.g. "openai:<model>" with an LLM


@runtime_checkable
class Classifier(Protocol):
    """Common interface; lets heuristic and LLM be swapped without coupling calls."""

    async def classify(self, features: dict) -> Verdict: ...


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


class HeuristicClassifier:
    """LLM-free classifier: explains the verdict from timing,
    depth and pattern signals. Works without consuming tokens and serves as the fallback.

    Expected `features` (all optional, with tolerant defaults):
        score (float), request_count (int), max_depth (int),
        matched_rules (list[str]), intervals (list[float] in seconds).
    """

    async def classify(self, features: dict) -> Verdict:
        reasons: list[str] = []
        conf = float(features.get("score", 0.0))  # anchored on the rules score

        intervals = [x for x in features.get("intervals", []) if x and x > 0]
        if len(intervals) >= 3:
            avg = sum(intervals) / len(intervals)
            std = math.sqrt(sum((x - avg) ** 2 for x in intervals) / len(intervals))
            if avg > 0 and std / avg < 0.35:
                conf += 0.15
                reasons.append(f"very regular rhythm (cv={std / avg:.2f})")

        max_depth = int(features.get("max_depth", 0))
        if max_depth >= 6:
            conf += 0.15
            reasons.append(f"descent to depth {max_depth}")

        request_count = int(features.get("request_count", 0))
        if request_count >= 20:
            conf += 0.1
            reasons.append(f"{request_count} sustained requests")

        matched = features.get("matched_rules", []) or []
        if "exhaustive_fanout" in matched:
            conf += 0.1
            reasons.append("exhaustive fan-out")
        if "no_asset_render" in matched:
            reasons.append("no asset rendering")

        conf = _clamp01(conf)
        text = "; ".join(reasons) if reasons else "senales debiles"
        return Verdict(is_ai=conf >= 0.6, confidence=conf, reasoning=text)


class LlmClassifier:
    """LLM-based classifier via an OpenAI-compatible API.

    Sends a compact session summary and asks for a JSON verdict. On
    any error (network, status != 2xx, invalid JSON) it falls back to the heuristic.
    """

    def __init__(self, options: AiConfirmationOptions) -> None:
        self._opt = options
        self._fallback = HeuristicClassifier()

    async def classify(self, features: dict) -> Verdict:
        try:
            return await self._classify_llm(features)
        except Exception as exc:  # graceful degradation: we never propagate
            log.warning("[ai_analyst] LLM no disponible (%s); uso heuristico", exc)
            return await self._fallback.classify(features)

    async def _classify_llm(self, features: dict) -> Verdict:
        url = self._opt.base_url.rstrip("/") + "/chat/completions"
        payload = {
            "model": self._opt.model,
            "temperature": 0,
            "max_tokens": 200,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a security analyst. You determine whether an HTTP session against "
                        "a honeypot was generated by an AI agent/automated bot or by a "
                        "human. Reply ONLY with JSON: "
                        '{"is_ai_agent":bool,"confidence":0..1,"reasoning":"brief"}.'
                    ),
                },
                {"role": "user", "content": self._build_prompt(features)},
            ],
        }
        headers = {
            "Authorization": f"Bearer {self._opt.api_key}",
            "HTTP-Referer": "https://github.com/moqesh-ai",
            "X-Title": "Moqesh AI",
        }
        async with httpx.AsyncClient(timeout=_LLM_TIMEOUT_S) as client:
            resp = await client.post(url, json=payload, headers=headers)

        if resp.status_code // 100 != 2:
            log.warning("[ai_analyst] LLM status %s; uso heuristico", resp.status_code)
            return await self._fallback.classify(features)

        content = resp.json()["choices"][0]["message"]["content"] or ""
        parsed = _extract_json(content)
        raw_ai = parsed.get("is_ai_agent", False)
        is_ai = raw_ai is True or (isinstance(raw_ai, str) and raw_ai.lower() == "true")
        conf = parsed.get("confidence", 0.5)
        conf = _clamp01(float(conf)) if isinstance(conf, (int, float, str)) else 0.5
        reasoning = str(parsed.get("reasoning", ""))
        return Verdict(is_ai, conf, reasoning, model_attribution=f"openai:{self._opt.model}")

    @staticmethod
    def _build_prompt(features: dict) -> str:
        lines = [
            f"UA: {features.get('user_agent') or '(none)'}",
            "requests={rc} max_depth={md} rules_score={sc:.2f} rules={rules}".format(
                rc=features.get("request_count", 0),
                md=features.get("max_depth", 0),
                sc=float(features.get("score", 0.0)),
                rules=",".join(features.get("matched_rules", []) or []),
            ),
            f"tokens_estimated={features.get('tokens_estimated', 0)}",
            "paths (muestra):",
        ]
        paths = features.get("paths", []) or []
        intervals = features.get("intervals", []) or []
        for i, path in enumerate(paths[:_MAX_BEATS_IN_PROMPT]):
            # intervals[i] is the gap before paths[i]; the first has no predecessor.
            iv = intervals[i - 1] if 0 < i <= len(intervals) else 0.0
            lines.append(f"  {path} | {iv:.1f}s")
        return "\n".join(lines)


def _extract_json(content: str) -> dict:
    """Extract the first JSON object from the LLM text (tolerates ```json ... ``` and prose)."""
    i, j = content.find("{"), content.rfind("}")
    if i < 0 or j <= i:
        return {}
    try:
        return json.loads(content[i : j + 1])
    except (ValueError, TypeError):
        return {}


def build_classifier(options: AiConfirmationOptions) -> Classifier:
    """Build the classifier based on provider/enabled.

    Returns the heuristic unless the module is enabled with provider
    "openai" and credentials (base_url + api_key) are present.
    """
    if options.enabled and options.provider.lower() == "openai" and options.base_url and options.api_key:
        return LlmClassifier(options)
    return HeuristicClassifier()


def _parse_rules(matched_rules: str | None) -> list[str]:
    if not matched_rules:
        return []
    return [r.strip() for r in matched_rules.split(",") if r.strip()]


def _build_features(db: Session, session: AgentSession) -> dict:
    """Build the features dict from the session and its request logs."""
    rows = db.execute(
        select(RequestLog.timestamp, RequestLog.path)
        .where(RequestLog.session_id == session.id)
        .order_by(RequestLog.timestamp)
    ).all()
    paths = [r.path for r in rows]
    intervals = [(rows[i].timestamp - rows[i - 1].timestamp).total_seconds() for i in range(1, len(rows))]
    return {
        "session_id": session.id,
        "source_ip": session.source_ip,
        "user_agent": session.user_agent,
        "score": session.ai_probability_score,
        "request_count": session.request_count,
        "max_depth": session.max_depth_reached,
        "tokens_estimated": session.tokens_estimated,
        "matched_rules": _parse_rules(session.matched_rules),
        "paths": paths,
        "intervals": intervals,
    }


async def confirm_session(
    db: Session,
    session: AgentSession,
    classifier: Classifier,
    options: AiConfirmationOptions,
) -> None:
    """Confirm a gray-zone session and write the verdict into `session`.

    If the score does NOT fall in [gray_zone_low, gray_zone_high] it does nothing (the session
    is already clear enough for the rules engine). Otherwise it asks the
    classifier for a verdict and updates `verdict`, `verdict_confidence`,
    `verdict_reasoning` and `model_attribution`; then commits via `db`.

    Verdict (same as the C# version): only set when confidence reaches the
    threshold; with low confidence the session stays "Unknown" to retry with
    more data.
    """
    score = session.ai_probability_score
    if not (options.gray_zone_low <= score <= options.gray_zone_high):
        return  # outside the gray zone: the classifier is not consumed

    features = _build_features(db, session)
    verdict = await classifier.classify(features)

    session.verdict_confidence = verdict.confidence
    session.verdict_reasoning = verdict.reasoning
    if verdict.model_attribution:
        session.model_attribution = verdict.model_attribution

    if verdict.confidence >= options.confirm_threshold:
        session.verdict = "AiConfirmed" if verdict.is_ai else "HumanLikely"
    else:
        session.verdict = "Unknown"

    db.commit()
