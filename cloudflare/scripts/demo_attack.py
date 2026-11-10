#!/usr/bin/env python3
"""Operator-paced demo against the dedicated Moqesh staging deployment."""

import argparse
import ipaddress
import json
import re
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

BASE_URL = "https://staging.kurocyber.com"
ADMIN_URL = "https://admin-staging.kurocyber.com"
BAIT_PATH = "/api/private/account"
TRACE_PATH = "/cdn-cgi/trace"
HOP_PATHS = (
    "/api/private/billing",
    "/api/private/team",
    "/api/private/admin/users",
    "/api/private/admin/keys",
    "/api/internal/services",
    "/api/internal/deploy/secrets",
    "/api/internal/db/credentials",
    "/api/internal/backups",
    "/api/internal/vault/root",
)
ALLOWED_PATHS = frozenset({"/", "/.env", BAIT_PATH, TRACE_PATH, *HOP_PATHS})
LEAD_TOKEN = re.compile(r"Bearer [a-f0-9]{64}")
MAX_RESPONSE_BYTES = 65536
MAX_DISPLAY_CHARS = 4000
TIMEOUT_SECONDS = 20


class DemoError(Exception):
    """The demo cannot safely continue or an expected result was not observed."""


class DemoCancelled(Exception):
    """The operator stopped the walkthrough."""


@dataclass(frozen=True)
class Response:
    status: int
    headers: Mapping[str, str]
    body: str
    truncated: bool = False


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def safe_text(text: str) -> str:
    return "".join(char if char.isprintable() or char in "\n\t" else ascii(char)[1:-1] for char in text)


def send_request(path: str, headers: dict[str, str]) -> Response:
    if path not in ALLOWED_PATHS:
        raise DemoError("Refusing a request outside the fixed staging demo paths.")
    request = Request(BASE_URL + path, headers=headers, method="GET")
    # Keep one direct source connection; never forward bait credentials through environment proxies.
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        try:
            response = opener.open(request, timeout=TIMEOUT_SECONDS)
        except HTTPError as error:
            response = error
        try:
            data = response.read(MAX_RESPONSE_BYTES + 1)
            return Response(
                response.status,
                dict(response.headers.items()),
                data[:MAX_RESPONSE_BYTES].decode("utf-8", errors="replace"),
                truncated=len(data) > MAX_RESPONSE_BYTES,
            )
        finally:
            response.close()
    except (URLError, OSError, ValueError) as error:
        raise DemoError(f"Staging request failed; no automatic retry: {safe_text(str(error))}") from error


def approve(input_fn: Callable[[str], str], output: Callable[[str], None]) -> None:
    while True:
        try:
            answer = input_fn("Type NEXT to send this request, or QUIT to stop: ").strip()
        except (EOFError, KeyboardInterrupt) as error:
            raise DemoCancelled from error
        if answer == "NEXT":
            return
        if answer == "QUIT":
            raise DemoCancelled
        output("Not approved. Only uppercase NEXT sends a request; QUIT exits.")


def show_response(response: Response, output: Callable[[str], None]) -> None:
    output(f"\n--- RESPONSE ---\nHTTP {response.status}")
    for name, value in response.headers.items():
        if name.lower() in {"content-type", "cache-control", "retry-after", "cf-ray"}:
            output(safe_text(f"{name}: {value}"))
    output("Response body:")
    body = safe_text(response.body)
    output(body[:MAX_DISPLAY_CHARS] or "(empty)")
    if len(body) > MAX_DISPLAY_CHARS or response.truncated:
        output(
            f"[OUTPUT TRUNCATED: display limit {MAX_DISPLAY_CHARS} characters; "
            f"network read limit {MAX_RESPONSE_BYTES} bytes]"
        )


def is_runner(response: Response) -> bool:
    headers = {name.lower(): value for name, value in response.headers.items()}
    return (
        response.status == 200
        and "text/html" in headers.get("content-type", "").lower()
        and "Signal Sprint" in response.body
        and not response.truncated
    )


def json_body(response: Response) -> object:
    try:
        return json.loads(response.body)
    except json.JSONDecodeError:
        return None


def next_lead(response: Response, expected_path: str) -> str:
    body = json_body(response)
    lead = body.get("next") if isinstance(body, dict) else None
    if not isinstance(lead, dict) or lead.get("endpoint") != BASE_URL + expected_path:
        raise DemoError("Rabbit-hole lead is missing or points outside the fixed staging chain; stopping.")
    authorization = lead.get("authorization")
    if not isinstance(authorization, str) or LEAD_TOKEN.fullmatch(authorization) is None:
        raise DemoError("Rabbit-hole lead has a malformed bearer token; stopping.")
    return authorization


def extract_key(response: Response) -> str:
    keys = re.findall(r"^API_KEY=([a-f0-9]{64})\r?$", response.body, re.MULTILINE)
    urls = re.findall(r"^API_BASE_URL=(.*)\r?$", response.body, re.MULTILINE)
    if (
        response.status != 200
        or response.truncated
        or len(keys) != 1
        or len(re.findall(r"^API_KEY=", response.body, re.MULTILINE)) != 1
        or len(urls) != 1
        or urls[0].rstrip("\r") != BASE_URL + BAIT_PATH
    ):
        raise DemoError("STAGE 3: expected exactly one synthetic key and the fixed staging bait URL.")
    return keys[0]


def parse_trace_ip(response: Response) -> str:
    values = re.findall(r"^ip=(.*)$", response.body, re.MULTILINE)
    if response.status != 200 or len(values) != 1:
        raise DemoError("Could not determine the source IP Cloudflare sees for this machine.")
    try:
        return str(ipaddress.ip_address(values[0].strip()))
    except ValueError as error:
        raise DemoError("Cloudflare trace returned an invalid source IP.") from error


def fetch_source_ip() -> str:
    return parse_trace_ip(send_request(TRACE_PATH, {"Accept": "text/plain", "User-Agent": "Moqesh-Staging-Demo/1.0"}))


def run_demo(
    *,
    input_fn: Callable[[str], str] = input,
    output: Callable[[str], None] = print,
    request_fn: Callable[[str, dict[str, str]], Response] = send_request,
    source_ip_fn: Callable[[], str] | None = None,
) -> None:
    output(f"MOQESH GUIDED STAGING DEMO\nTarget: {BASE_URL}\nOperator dashboard: {ADMIN_URL}")
    output(
        "WARNING: this is a real staging exercise, not a dry run. Confirmation creates events and "
        "contains your public source IP (maze until the 10-hop rabbit hole ends or 15 minutes pass, "
        "then a 24-hour block). "
        "Other people sharing that IP may be affected. Incognito does not change your IP.\n"
        "Keep the dashboard open. Before starting, remove any existing containment for this source "
        "and ensure this demo source is NOT allowlisted. Keep the same network/VPN throughout.\n"
        "Only planted synthetic credentials are printed. No Cloudflare/HCP tokens are needed. "
        "Request bodies are empty. No redirects, retries, flooding, or automatic admin changes.\n"
        "QUIT/Ctrl-C stops requests but does NOT undo containment or erase events."
    )
    if source_ip_fn is not None:
        output(
            f"\n{'=' * 68}\nPREFLIGHT: SOURCE IP CHECK (read-only Cloudflare edge request, no honeypot event)\n"
            f"GET {BASE_URL}{TRACE_PATH}"
        )
        approve(input_fn, output)
        source_ip = source_ip_fn()
        output(
            f"Cloudflare sees THIS SCRIPT as: {source_ip}\n"
            f"Containment is per public IP. Open {BASE_URL}{TRACE_PATH} in the browser you will refresh "
            "and compare its ip= line. If it differs (IPv4 vs IPv6, VPN, another machine), that browser "
            "will NOT be blocked at Stage 5. Type NEXT only if they match (or you will check with this script)."
        )
        approve(input_fn, output)
    base_headers = {"Accept": "*/*", "User-Agent": "Moqesh-Staging-Demo/1.0"}
    key = ""
    authorization = ""

    def run_stage(number, title, path, expected, checkpoint, validate, headers=None, manual=None):
        headers = headers or dict(base_headers)
        output(f"\n{'=' * 68}\nSTAGE {number}/8: {title}\nExpected: {expected}")
        if manual:
            output(manual)
        output(f"\n--- REQUEST PREVIEW ---\nGET {BASE_URL}{path}\nHost: {urlsplit(BASE_URL).hostname}")
        for name, value in headers.items():
            output(f"{name}: {value}")
        output("Request body: (none)")
        approve(input_fn, output)
        response = request_fn(path, headers)
        show_response(response, output)
        try:
            valid = validate(response)
        except DemoError as error:
            raise DemoError(f"STAGE {number}: {error}") from error
        if not valid or response.truncated:
            raise DemoError(
                f"STAGE {number}: expected result NOT observed. Stopping; no further requests sent. "
                "Check containment/allowlist, staging availability, and runtime settings. "
                "For recovery, manually Unblock the source in the dashboard and rerun."
            )
        output(f"\nSTAGE {number} PASSED. Operator checkpoint: {checkpoint}")

    def capture_key(response):
        nonlocal key
        key = extract_key(response)
        return True

    def confirm_reuse(response):
        nonlocal authorization
        body = json_body(response)
        if response.status != 200 or not isinstance(body, dict) or "data" not in body:
            return False
        authorization = next_lead(response, HOP_PATHS[0])
        return True

    def maze_decoy(response):
        return response.status == 404 and json_body(response) == {"error": "Not found"}

    run_stage(
        1,
        "NORMAL VISITOR",
        "/",
        "HTTP 200 HTML containing Signal Sprint.",
        "Show the normal game. Ordinary browsing does not create a detection event.",
        is_runner,
    )
    run_stage(
        2,
        "MISSING CREDENTIAL",
        BAIT_PATH,
        'HTTP 401 JSON {"error":"Unauthorized"}.',
        "In Detections, refresh the page: an invalid-key attempt should appear, not confirmed reuse.",
        lambda response: response.status == 401 and json_body(response) == {"error": "Unauthorized"},
    )
    run_stage(
        3,
        "DISCOVER THE BAIT",
        "/.env",
        "HTTP 200 with a synthetic API_KEY and the staging bait URL.",
        "In Detections, refresh: the lure view is unconfirmed. Merely discovering bait is not confirmation.",
        capture_key,
    )
    run_stage(
        4,
        "REUSE THE SYNTHETIC KEY",
        BAIT_PATH,
        "HTTP 200 fake account data, readonly=true, and a next lead (hop 1 of 10); starts containment.",
        "In Detections, refresh to inspect confirmed reuse. In Containment, refresh to inspect this "
        "source. Webhook delivery is disabled in this staging deployment.",
        confirm_reuse,
        headers={**base_headers, "Authorization": "Bearer " + key},
    )
    run_stage(
        5,
        "VERIFY MAZE DIVERSION",
        "/",
        'HTTP 404 JSON {"error":"Not found"}, NOT the runner.',
        "This 404 is the intentional maze decoy. Your source is no longer forwarded to the game. "
        "A different, uncontained public IP can still see the game.",
        maze_decoy,
    )
    output(
        f"\n{'=' * 68}\nSTAGE 6/8: FOLLOW THE RABBIT HOLE\n"
        "Expected: each hop returns HTTP 200 fake data with the next lead; hop 10 has no lead and "
        "blocks this source."
    )
    for index, path in enumerate(HOP_PATHS):
        hop = index + 2
        headers = {**base_headers, "Authorization": authorization}
        output(f"\n--- HOP {hop}/10 REQUEST PREVIEW ---\nGET {BASE_URL}{path}")
        for name, value in headers.items():
            output(f"{name}: {value}")
        output("Request body: (none)")
        approve(input_fn, output)
        response = request_fn(path, headers)
        show_response(response, output)
        if response.status != 200 or response.truncated:
            raise DemoError(f"STAGE 6 HOP {hop}: expected HTTP 200 fake data; stopping.")
        if index + 1 < len(HOP_PATHS):
            try:
                authorization = next_lead(response, HOP_PATHS[index + 1])
            except DemoError as error:
                raise DemoError(f"STAGE 6 HOP {hop}: {error}") from error
        else:
            body = json_body(response)
            if not isinstance(body, dict) or "next" in body:
                raise DemoError("STAGE 6 HOP 10: final hop unexpectedly offered another lead; stopping.")
    output(
        "\nSTAGE 6 PASSED. Operator checkpoint: In Detections, refresh to see rabbit hole hop "
        "events hop-2 through hop-10. In Containment, the source is now blocked."
    )
    run_stage(
        7,
        "VERIFY BLOCK",
        "/",
        "HTTP 403: the final hop blocked this source.",
        "In Containment, refresh: this source is blocked. Other public IPs still see the game.",
        lambda response: response.status == 403,
    )
    run_stage(
        8,
        "OPERATOR UNBLOCK AND RECOVERY",
        "/",
        "After manual unblock: HTTP 200 runner HTML again.",
        "Inspect the manual-unblock audit entry in Containment. Detection history remains available.",
        is_runner,
        manual=(
            f"MANUAL ACTION REQUIRED: open {ADMIN_URL}, choose Containment, refresh, "
            "select your demo source, click Unblock, and confirm. Check the audit entry. "
            "Only type NEXT below AFTER completing this action. No admin request is made by this script."
        ),
    )
    output(
        "\nDEMO COMPLETE: ordinary browsing -> rejected missing key -> bait discovery -> "
        "confirmed reuse -> maze diversion -> 10-hop rabbit hole -> block -> operator unblock -> "
        "normal browsing restored.\n"
        "HTTP behavior was verified. Dashboard events/audit require operator inspection; "
        "expiry, cross-source reuse, webhook delivery, and rate-limit exhaustion were not tested."
    )


def https_origin(value: str) -> str:
    parts = urlsplit(value.strip())
    try:
        port = parts.port
    except ValueError:
        port = -1
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username is not None
        or port is not None
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
    ):
        raise argparse.ArgumentTypeError("must be an https:// origin with no path, port, credentials, or query")
    return f"https://{parts.hostname.lower()}"


def main(argv: list[str] | None = None) -> int:
    global BASE_URL, ADMIN_URL
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog=(
            "Every request needs NEXT; QUIT exits. "
            "Requires an interactive terminal and Python 3.11+. No extra packages."
        ),
    )
    parser.add_argument(
        "--base-url", type=https_origin, default=BASE_URL, help="Protected hostname origin (default: %(default)s)"
    )
    parser.add_argument(
        "--admin-url", type=https_origin, default=ADMIN_URL, help="Admin dashboard origin (default: %(default)s)"
    )
    args = parser.parse_args(argv)
    BASE_URL, ADMIN_URL = args.base_url, args.admin_url
    if not sys.stdin.isatty():
        print("ERROR: run in an interactive terminal; unattended/piped approval is not supported.", file=sys.stderr)
        return 2
    try:
        run_demo(source_ip_fn=fetch_source_ip)
    except (DemoCancelled, KeyboardInterrupt):
        print("\nDemo cancelled. Existing events/containment remain; manually Unblock your source if needed.")
        return 130
    except DemoError as error:
        print(f"\nERROR: {error}", file=sys.stderr)
        print("If confirmation occurred, manually Unblock your source before another run.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
