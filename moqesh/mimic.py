"""Real-site profiler for Mimic mode (read-only).

Inspired by `Moqesh.TokenExhaust.SiteProfiler` (C#) but rewritten idiomatically:
it does a shallow, BOUNDED same-origin crawl (async httpx + the stdlib's html.parser,
no new dependencies) and extracts a JSON-serializable profile that
is stored in `SiteProfile.profile_json`. Generic: works against any
target domain.

Returned profile (all keys always present):
    {
      "paths":          [...],  # observed directories ("/app/", "/account/")
      "api_prefixes":   [...],  # API prefixes ("/api/v2", "/graphql")
      "resource_names": [...],  # leaf resource names ("login", "app.js")
      "tech_stack":     {...},  # tech detectada -> evidencia ("react": "html")
      "vocabulary":     [...],  # domain segments/words (vocabulary)
      "server_banner":  "...",  # real Server header (or "nginx" by default)
      "title":          "...",  # <title> of the first HTML page
    }
"""

from __future__ import annotations

import asyncio
import re
from collections import deque
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, urlunparse

import httpx

# --------------------------- limits and constants ---------------------------

_USER_AGENT = "Mozilla/5.0 (compatible; MoqeshProfiler/1.0)"
_MAX_BYTES = 2_000_000  # cap on body bytes read per page (anti-OOM)
_MAX_PATHS = 40
_MAX_API = 10
_MAX_RESOURCES = 40
_MAX_VOCAB = 60
_MAX_TECH = 12
_SEG_MIN, _SEG_MAX = 3, 24  # valid segment length for vocabulary
_LEAF_MAX = 48  # max length of a resource name

# Link schemes that are ignored (not navigable pages).
_SKIP_SCHEMES = ("mailto:", "tel:", "javascript:", "data:", "blob:", "about:")

# Stack hints: needle (in lowercase HTML) -> normalized name.
_TECH_NEEDLES: tuple[tuple[str, str], ...] = (
    ("__next_data__", "next.js"),
    ("data-reactroot", "react"),
    ("ng-version", "angular"),
    ("wp-content", "wordpress"),
    ("csrfmiddlewaretoken", "django"),
    ("laravel_session", "laravel"),
    ("_nuxt", "nuxt"),
    ("data-v-app", "vue"),
    ("__sveltekit", "svelte"),
    ("gatsby", "gatsby"),
    ("/cdn-cgi/", "cloudflare"),
    ("shopify", "shopify"),
    ("vite", "vite"),
)

_API_RE = re.compile(r"/(?:api|graphql|rest|v\d+)(?:/|$)", re.IGNORECASE)
_API_PREFIX_RE = re.compile(r"^(/[^/]*(?:api|graphql|rest|v\d)[^/]*(?:/v\d+)?)", re.IGNORECASE)
_SEG_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*$")
_LEAF_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_-]*")


# ------------------------------- parser HTML --------------------------------


class _HtmlScan(HTMLParser):
    """Extract links (href/src/action) and the <title>. Tolerant of broken HTML."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []
        self.title: str = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title":
            self._in_title = True
        for name, value in attrs:
            if value and name in ("href", "src", "action"):
                self.links.append(value)

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        # Only the first <title>; it may arrive in several chunks.
        if self._in_title and not self.title:
            text = data.strip()
            if text:
                self.title = text


# ------------------------------- helpers URL --------------------------------


def _is_http(url: str) -> bool:
    return url.startswith(("http://", "https://"))


def _normalize(url: str) -> str:
    """Canonicalize for dedupe: lowercase scheme/host and drop query and fragment."""
    p = urlparse(url)
    return urlunparse((p.scheme.lower(), p.netloc.lower(), p.path or "/", "", "", ""))


def _dir_of(path: str) -> str:
    """Containing directory of a path ("/a/b/c" -> "/a/b/"); "/" if it is the root."""
    p = path.rstrip("/")
    idx = p.rfind("/")
    return "/" if idx <= 0 else p[: idx + 1]


def _leaf_of(path: str) -> str:
    """Last segment (resource name); "" if the path is a directory."""
    if path.endswith("/"):
        return ""
    idx = path.rfind("/")
    return path[idx + 1 :] if idx >= 0 else path


def _api_prefix(path: str) -> str:
    m = _API_PREFIX_RE.match(path)
    return m.group(1) if m else "/api"


# ------------------------------- acumulador ---------------------------------


class _OrderedSet:
    """Insertion-ordered set with a cap; ignores extras once full."""

    def __init__(self, limit: int) -> None:
        self._data: dict[str, None] = {}
        self._limit = limit

    def add(self, key: str) -> None:
        if key and key not in self._data and len(self._data) < self._limit:
            self._data[key] = None

    def sorted(self) -> list[str]:
        return sorted(self._data)


# ------------------------------- descarga -----------------------------------


async def _fetch_html(client: httpx.AsyncClient, url: str) -> tuple[httpx.Response, str | None]:
    """Download a page. Returns (response, html) or (response, None) if it is not
    HTML. Reads at most `_MAX_BYTES` to bound memory."""
    async with client.stream("GET", url) as resp:
        ctype = resp.headers.get("content-type", "").lower()
        if "html" not in ctype:
            return resp, None
        chunks: list[bytes] = []
        total = 0
        async for chunk in resp.aiter_bytes():
            chunks.append(chunk)
            total += len(chunk)
            if total >= _MAX_BYTES:
                break
        enc = resp.charset_encoding or "utf-8"
        try:
            html = b"".join(chunks).decode(enc, errors="replace")
        except (LookupError, UnicodeError):
            html = b"".join(chunks).decode("utf-8", errors="replace")
        return resp, html


# ------------------------------- API publica --------------------------------


async def profile_site(
    target_url: str, *, max_pages: int = 40, timeout: float = 10.0, same_origin: bool = True
) -> dict:
    """Profile (read-only) a real site for Mimic mode.

    Does a bounded BFS crawl from `target_url`: at most `max_pages` pages,
    `timeout` seconds per request, without leaving the host unless `same_origin`
    is False. Never raises on network/HTML errors: at worst it returns a
    partial profile (or an empty one with the "nginx" banner).
    """
    base = urlparse(target_url)
    paths = _OrderedSet(_MAX_PATHS)
    api = _OrderedSet(_MAX_API)
    resources = _OrderedSet(_MAX_RESOURCES)
    vocab = _OrderedSet(_MAX_VOCAB)
    tech: dict[str, str] = {}
    server_banner = ""
    title = ""

    # Invalid target URL: empty but well-formed profile.
    if base.scheme not in ("http", "https") or not base.netloc:
        return _build(paths, api, resources, vocab, tech, server_banner, title)

    base_host = base.netloc.lower()
    seen: set[str] = set()
    queue: deque[str] = deque([_normalize(target_url)])
    pages = 0
    headers_done = False
    html_done = False

    limits = httpx.Timeout(timeout)
    headers = {"User-Agent": _USER_AGENT, "Accept": "text/html,application/xhtml+xml,*/*"}
    try:
        async with httpx.AsyncClient(timeout=limits, follow_redirects=True, headers=headers, max_redirects=5) as client:
            while queue and pages < max_pages:
                url = queue.popleft()
                if url in seen:
                    continue
                seen.add(url)

                try:
                    resp, html = await _fetch_html(client, url)
                except (httpx.HTTPError, OSError):
                    pages += 1  # count the attempt so a dead host does not hang us
                    continue

                # Headers: only from the first successful response.
                if not headers_done:
                    headers_done = True
                    sv = resp.headers.get("server", "").strip()
                    if sv:
                        server_banner = sv
                    xpb = resp.headers.get("x-powered-by", "").strip()
                    if xpb and len(tech) < _MAX_TECH:
                        tech[xpb.lower()] = "x-powered-by"

                pages += 1
                if html is None:
                    continue

                # First HTML page: title and stack detection.
                if not html_done:
                    html_done = True
                    scan_title, lower = _scan_meta(html)
                    if scan_title:
                        title = scan_title
                        _harvest_words(title, vocab)
                    for needle, name in _TECH_NEEDLES:
                        if needle in lower and len(tech) < _MAX_TECH:
                            tech.setdefault(name, "html")

                # Link and vocabulary extraction.
                for raw in _links(html):
                    abs_url = _resolve(url, raw)
                    if abs_url is None:
                        continue
                    pu = urlparse(abs_url)
                    on_host = pu.netloc.lower() == base_host
                    if not on_host and same_origin:
                        continue  # off-origin: do not follow or record

                    path = pu.path or "/"
                    d = _dir_of(path)
                    if d != "/":
                        paths.add(d)
                    leaf = _leaf_of(path)
                    if leaf and len(leaf) <= _LEAF_MAX and _LEAF_RE.match(leaf):
                        resources.add(leaf.lower())
                    for seg in path.strip("/").split("/"):
                        if _SEG_MIN <= len(seg) <= _SEG_MAX and _SEG_RE.match(seg):
                            vocab.add(seg.lower())
                    if _API_RE.search(path):
                        api.add(_api_prefix(path))

                    # Enqueue new navigable pages (no file extension).
                    if (on_host or not same_origin) and "." not in leaf and len(queue) < max_pages * 4:
                        norm = _normalize(abs_url)
                        if norm not in seen:
                            queue.append(norm)
    except Exception:
        # Last safety net: return what was accumulated up to the failure.
        pass

    return _build(paths, api, resources, vocab, tech, server_banner, title)


def profile_site_sync(target_url: str, *, max_pages: int = 40, timeout: float = 10.0, same_origin: bool = True) -> dict:
    """Synchronous wrapper of `profile_site` for non-async contexts (CLI, tests).

    Do not use inside an already running event loop (use `profile_site` directly).
    """
    return asyncio.run(profile_site(target_url, max_pages=max_pages, timeout=timeout, same_origin=same_origin))


# ------------------------------- internos -----------------------------------


def _links(html: str) -> list[str]:
    """Return the HTML's links; tolerates malformed documents."""
    parser = _HtmlScan()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        pass  # html.parser rarely raises, but it must not take down the crawl
    return parser.links


def _scan_meta(html: str) -> tuple[str, str]:
    """Extract the <title> and also return the lowercased HTML (for stack detection)."""
    parser = _HtmlScan()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        pass
    return parser.title, html.lower()


def _resolve(current: str, raw: str) -> str | None:
    """Resolve a link to an absolute http(s) URL; None if it is not navigable."""
    raw = raw.strip()
    if not raw or raw.startswith("#"):
        return None
    if raw.lower().startswith(_SKIP_SCHEMES):
        return None
    try:
        abs_url = urljoin(current, raw)
    except ValueError:
        return None
    return abs_url if _is_http(abs_url) else None


def _harvest_words(text: str, vocab: _OrderedSet) -> None:
    """Add a text's useful words (e.g. the title) to the vocabulary."""
    for w in _WORD_RE.findall(text):
        if _SEG_MIN <= len(w) <= _SEG_MAX:
            vocab.add(w.lower())


def _build(
    paths: _OrderedSet,
    api: _OrderedSet,
    resources: _OrderedSet,
    vocab: _OrderedSet,
    tech: dict[str, str],
    server_banner: str,
    title: str,
) -> dict:
    """Assemble the JSON-serializable profile with all keys present."""
    return {
        "paths": paths.sorted(),
        "api_prefixes": api.sorted(),
        "resource_names": resources.sorted(),
        "tech_stack": dict(tech),
        "vocabulary": vocab.sorted(),
        "server_banner": server_banner or "nginx",
        "title": title,
    }
