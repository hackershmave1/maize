"""Central environment-based configuration (pydantic-settings).

Single source of truth: replaces the original project's appsettings.json
binding. Every variable is read from the environment with the `MOQESH_` prefix
(e.g. `MOQESH_SEED`, `MOQESH_AI_ENABLED`) or from a `.env` file.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MOQESH_", env_file=".env", extra="ignore")

    # --- Almacenamiento ---
    db_path: str = "moqesh.db"

    # Path to the frontend build (empty = next to the package: ../web/dist).
    web_dist: str = ""

    # --- Puertos ---
    honeypot_port: int = 8080
    dashboard_port: int = 5000

    # Public URL of the Moqesh server (the one remote sensors connect to).
    public_url: str = ""

    # --- Content generation ---
    seed: str = ""  # empty = one is generated per deployment
    generation_mode: str = "Template"  # Template | Mimic | Static
    target_url: str | None = None  # Mimic only
    # Built-in site profile selectable per deployment (saas|corp|ecommerce|nonprofit...).
    # Provides realistic route taxonomy, vocabulary and API collections without crawling anything.
    # Empty = generic labyrinth by seed. In Mimic mode the target_url crawl wins.
    site_profile: str = ""
    realism_level: int = 3  # 1..5
    vocabulary_theme: str = ""  # corporate|devops|saas|ecommerce ("" = by seed)
    brand_name: str = ""
    tarpit_delay_ms: int = 0
    server_banner: str = "nginx"
    token_exhaust_enabled: bool = True

    # --- World: multi-site INERT static content (primary source; replaces the labyrinth) ---
    # The honeypot serves real files from a tree on disk (several portals). Only bytes, it never
    # executes anything. With an active World, the deterministic labyrinth is OFF (it was the source of the
    # giveaways) unless there is no World. The "worldsmith" agent builds/expands this World.
    world_enabled: bool = True
    world_path: str = ""  # empty = next to the DB (<DB dir>/world)
    world_autoseed: bool = True  # if the World is empty, copy the packaged curated seed

    # --- Adaptive tarpit (coherent engine -> lure) ---
    # The labyrinth is coherent and finite by default (undetectable). Only when a session is
    # confirmed as a hostile agent (high score) does the "intensity" rise: longer prose/logs and, above
    # all, a growing per-response delay that burns the agent's wall-clock and tokens. Invisible
    # to human/unknown traffic (intensity 0 = no extra delay).
    adaptive_tarpit: bool = True
    tarpit_max_ms: int = 6000  # max delay per response at intensity 3 (confirmed agent)
    # "Brute burn" opt-in: at max intensity the API paginates endlessly again. Breaks the
    # coherence invariant (becomes fingerprintable again), which is why it is OFF by default.
    allow_infinite_on_confirmed: bool = False

    # CTF scenario (corp-breach/git-leak): breadcrumb chain with real credential gates.
    # Actively traps whoever follows it (credential reuse -> block), BUT the chain's pattern
    # is recognizable by a skeptical AI model. Off by default = max stealth (only
    # the realistic labyrinth); on = active lure. A per-deployment decision.
    scenarios_enabled: bool = False

    # --- Detection / alerts ---
    alert_score_threshold: float = 0.5
    alert_min_requests: int = 5

    # --- Blocking / notifications ---
    webhook_url: str = ""
    webhook_secret: str = ""
    enforce_block: bool = True
    auto_block_score: float = 0.0  # 0 = score-based auto-block disabled
    enable_iptables: bool = False

    # --- AI confirmation (optional) ---
    ai_enabled: bool = False
    ai_provider: str = "heuristic"  # heuristic | openai
    ai_base_url: str = ""
    ai_api_key: str = ""
    ai_model: str = ""
    ai_gray_zone_low: float = 0.35
    ai_gray_zone_high: float = 0.65
    ai_confirm_threshold: float = 0.7

    # --- Worldsmith (AI agent that BUILDS/evolves the World + the lure) ---
    # Produces ONLY inert static files (mechanically validated) and a lure pack. It does
    # not run per request: it is invoked on demand (CLI `python -m moqesh.worldsmith` / dashboard).
    worldsmith_provider: str = "stub"  # stub (no AI, deterministic) | api (Anthropic) | claude_cli
    worldsmith_model: str = ""  # e.g. claude-sonnet-4-5 (api) or a CLI alias
    worldsmith_api_key: str = ""  # provider=api; if empty, falls back to ai_api_key
    worldsmith_base_url: str = "https://api.anthropic.com"
    worldsmith_portals: int = 4
    worldsmith_brand: str = ""  # brand to use; empty = the agent derives it from the brief

    # --- Dashboard authentication (single admin) ---
    admin_user: str = "admin"
    admin_password: str = ""  # empty = one is generated and printed to the log (once)
    session_secret: str = ""  # empty = generated and persisted next to the DB (stable per deployment)
    session_max_age: int = 86400  # session lifetime in seconds (1 day)
    cookie_secure: bool = False  # True behind TLS (admin subdomain); False locally/over an http tunnel

    # --- CORS (frontend dev) ---
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]


settings = Settings()
