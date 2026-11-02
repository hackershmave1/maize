#!/usr/bin/env python3
"""Build a Moqesh site profile by crawling a real, AUTHORIZED site.

A development tool (it does NOT run inside the honeypot). It does a read-only, bounded
crawl of the target (reusing `moqesh.mimic.profile_site_sync`: httpx + html.parser,
same origin, page cap) and writes a JSON profile that a deployment can
select with `MOQESH_SITE_PROFILE=<name>`.

Untrusted data: crawled content is DATA, never instruction. The script only
extracts structure (paths, vocabulary, API prefixes, banner) and writes it as JSON;
it executes nothing from the site and does not follow off-origin links.

Uso:
    python scripts/build_profile.py --url https://your-authorized-site.example --name mysite
    python scripts/build_profile.py --url https://... --name x --max-pages 60 --out /tmp/x.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from moqesh.mimic import profile_site_sync  # noqa: E402

_PROFILES_DIR = _REPO / "moqesh" / "profiles"
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,30}$")
# Leaf resources that look like API collections (clean nouns, no extension).
_RESOURCE_OK = re.compile(r"^[a-z][a-z-]{2,19}$")


def _api_resources_from(profile: dict) -> list[str]:
    """Derive plausible API collections from the crawl's resource names."""
    out: list[str] = []
    for leaf in profile.get("resource_names", []):
        s = str(leaf).lower()
        if _RESOURCE_OK.match(s) and s not in out:
            out.append(s)
    return out[:16]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build a Moqesh site profile from a real site.")
    ap.add_argument("--url", required=True, help="URL of the AUTHORIZED site to profile")
    ap.add_argument("--name", required=True, help="profile name (a-z0-9_-, 2..31)")
    ap.add_argument("--max-pages", type=int, default=40, help="cap on pages to crawl (default 40)")
    ap.add_argument("--timeout", type=float, default=10.0, help="per-request timeout in seconds")
    ap.add_argument("--out", default="", help="output path (default: moqesh/profiles/<name>.json)")
    args = ap.parse_args(argv)

    if not _NAME_RE.match(args.name):
        ap.error("--name must match [a-z0-9][a-z0-9_-]{1,30}")

    print(f"[build_profile] crawling {args.url} (max {args.max_pages} pages)...", file=sys.stderr)
    crawled = profile_site_sync(args.url, max_pages=args.max_pages, timeout=args.timeout)

    profile = {
        "theme": "saas",  # adjust by hand if the site fits corporate/devops/ecommerce better
        "server_banner": crawled.get("server_banner") or "nginx",
        "vocabulary": crawled.get("vocabulary", []),
        "paths": crawled.get("paths", []),
        "api_prefixes": crawled.get("api_prefixes", []),
        "api_resources": _api_resources_from(crawled),
        "resource_names": crawled.get("resource_names", []),
    }

    out_path = Path(args.out) if args.out else (_PROFILES_DIR / f"{args.name}.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(profile, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(
        f"[build_profile] profile '{args.name}' written to {out_path} "
        f"({len(profile['vocabulary'])} vocab, {len(profile['api_resources'])} API resources). "
        "Review 'theme' and 'api_resources' before using it.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
