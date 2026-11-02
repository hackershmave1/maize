#!/bin/sh
# moqesh-ship.sh - Moqesh agentless shipper (POSIX sh).
#
# Runs from cron on the customer's server. Reads the web server's access log,
# keeps ONLY the lines that match the lure prefix (privacy: real user
# traffic never leaves the host), and sends them HMAC-signed
# to the Moqesh server. Installs nothing: it only needs sh, curl, openssl and awk.
#
# Idempotent: stores a byte offset into the log; the server also deduplicates.
# NEVER modifies or deletes the source log.
#
# Environment variables (see moqesh/clients/README.md):
#   MOQESH_SERVER     base URL of the Moqesh server          (required)
#   MOQESH_KEY_ID     the sensor's key identifier            (required)
#   MOQESH_SECRET     the sensor's HMAC secret               (required)
#   MOQESH_LOG        path to the access log                 (required)
#   MOQESH_BASE_PATH  lure prefix, e.g. /lure                (required)
#   MOQESH_FORMAT     nginx|apache|caddy|json|raw            (default nginx)
#   MOQESH_STATE      offset file                            (default: next to the script)
#   MOQESH_DRY_RUN    1 = print what would be sent and exit  (default empty)
#
# Documented decision: if /control returns enabled=false, nothing is sent and the
# offset is NOT advanced, so lure lines are not lost when the sensor is re-enabled.

LC_ALL=C
export LC_ALL

CAP=20000  # cap on lines per send (the server also caps at 20000)

die() { printf 'moqesh-ship: %s\n' "$*" >&2; exit 1; }
info() { printf 'moqesh-ship: %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# 1. Environment and validation
# ---------------------------------------------------------------------------
MOQESH_SERVER=${MOQESH_SERVER:-}
MOQESH_KEY_ID=${MOQESH_KEY_ID:-}
MOQESH_SECRET=${MOQESH_SECRET:-}
MOQESH_LOG=${MOQESH_LOG:-}
MOQESH_BASE_PATH=${MOQESH_BASE_PATH:-}
MOQESH_FORMAT=${MOQESH_FORMAT:-nginx}
MOQESH_DRY_RUN=${MOQESH_DRY_RUN:-}

[ -n "$MOQESH_SERVER" ]    || die "MOQESH_SERVER is missing"
[ -n "$MOQESH_KEY_ID" ]    || die "MOQESH_KEY_ID is missing"
[ -n "$MOQESH_SECRET" ]    || die "MOQESH_SECRET is missing"
[ -n "$MOQESH_LOG" ]       || die "MOQESH_LOG is missing"
# Empty prefix = ALL traffic would be sent -> forbidden for privacy.
[ -n "$MOQESH_BASE_PATH" ] || die "MOQESH_BASE_PATH is missing (without a prefix, real traffic would be sent)"

MOQESH_SERVER=${MOQESH_SERVER%/}  # no trailing slash -> avoids //control

command -v curl    >/dev/null 2>&1 || die "curl is not available"
command -v openssl >/dev/null 2>&1 || die "openssl is not available"
command -v awk     >/dev/null 2>&1 || die "awk is not available"

# The script's own directory (for the default state).
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || SELF_DIR=.

# Default state: unique per log path (several logs -> several offsets).
if [ -n "${MOQESH_STATE:-}" ]; then
  STATE=$MOQESH_STATE
else
  _h=$(printf '%s' "$MOQESH_LOG" | cksum 2>/dev/null | cut -d' ' -f1)
  [ -n "$_h" ] || _h=default
  STATE="$SELF_DIR/.moqesh-ship-$_h.state"
fi

# ---------------------------------------------------------------------------
# Signing helpers
# ---------------------------------------------------------------------------

# Unix timestamp with decimals (falls back to integers if date does not support %N).
mq_ts() {
  _t=$(date +%s.%N 2>/dev/null)
  case "$_t" in
    *N*|'') _t=$(date +%s) ;;
  esac
  printf '%s' "$_t"
}

# sign_file TS FILE -> "sha256=<hex>" over  TS + "." + <bytes of FILE>
# (identico a moqesh.security.sign: HMAC_SHA256(secret, ts.encode()+b"."+body)).
sign_file() {
  _ts=$1; _f=$2
  _hex=$({ printf '%s.' "$_ts"; cat "$_f"; } \
    | openssl dgst -sha256 -hmac "$MOQESH_SECRET" 2>/dev/null \
    | awk '{print $NF}')
  [ -n "$_hex" ] || die "openssl failed to compute the HMAC"
  printf 'sha256=%s' "$_hex"
}

# Escape a short scalar (format / base_path) for JSON.
json_scalar() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# ---------------------------------------------------------------------------
# Temporary files
# ---------------------------------------------------------------------------
TMPD=$(mktemp -d 2>/dev/null) || die "could not create a temporary directory"
trap 'rm -rf "$TMPD"' EXIT INT TERM HUP

RAW="$TMPD/raw"            # new bytes from the log
ESC="$TMPD/esc"            # lure lines, already escaped (one per line)
CNTF="$TMPD/cnt"           # number of lure lines
HDR="$TMPD/hdr"            # /control headers
CBODY="$TMPD/cbody"        # /control body
EMPTY="$TMPD/empty"        # empty body (signature of the GET)
: > "$EMPTY"

# ---------------------------------------------------------------------------
# 2. Offset + rotation
# ---------------------------------------------------------------------------
[ -e "$MOQESH_LOG" ] || die "the log does not exist: $MOQESH_LOG"
[ -r "$MOQESH_LOG" ] || die "no read permission on: $MOQESH_LOG"

cur_size=$(wc -c < "$MOQESH_LOG" 2>/dev/null | tr -d ' ')
case "$cur_size" in ''|*[!0-9]*) die "could not measure the size of $MOQESH_LOG" ;; esac

offset=0
if [ -f "$STATE" ]; then
  offset=$(cat "$STATE" 2>/dev/null)
  case "$offset" in ''|*[!0-9]*) offset=0 ;; esac
fi

# Rotation / truncation: the log shrank -> start from zero.
if [ "$cur_size" -lt "$offset" ]; then
  info "rotation detected ($cur_size < $offset); resetting offset to 0"
  offset=0
fi

if [ "$cur_size" -eq "$offset" ]; then
  info "no new lines (offset $offset)"
  exit 0
fi

# Read only what is new since the offset (tail -c +N is 1-based).
tail -c "+$((offset + 1))" "$MOQESH_LOG" > "$RAW" 2>/dev/null \
  || die "could not read $MOQESH_LOG from the offset (permissions?)"

# Does it end in a newline? The last line may be half-written.
NL='
'
ends_nl=0
if [ -s "$RAW" ]; then
  _lc=$(tail -c 1 "$RAW" 2>/dev/null; printf x)
  case "$_lc" in "${NL}x") ends_nl=1 ;; esac
fi

# ---------------------------------------------------------------------------
# 3. Prefix filtering + JSON escaping + count of consumed bytes
#
# consumed = bytes of ALL complete lines (whether or not they match the prefix), to
# advance the offset without reprocessing real traffic. Only the lines that CONTAIN
# the prefix are accumulated for sending. The last line without '\n' is left pending.
# ---------------------------------------------------------------------------
: > "$ESC"
consumed=$(awk \
  -v base="$MOQESH_BASE_PATH" -v ends_nl="$ends_nl" \
  -v linesfile="$ESC" -v countfile="$CNTF" '
function esc(s,   out, i, c, b, n) {
  out = "\"";
  n = length(s);
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1); b = ordv[c];
    if (c == "\\")      out = out "\\\\";
    else if (c == "\"") out = out "\\\"";
    else if (b == 8)    out = out "\\b";
    else if (b == 9)    out = out "\\t";
    else if (b == 10)   out = out "\\n";
    else if (b == 12)   out = out "\\f";
    else if (b == 13)   out = out "\\r";
    else if (b < 32)    out = out sprintf("\\u%04x", b);
    else                out = out c;
  }
  return out "\"";
}
function flush(line) {
  consumed += length(line) + 1;           # +1 for the \n that ended it
  if (index(line, base) > 0) {            # lure lines only
    print esc(line) > linesfile;
    cnt++;
  }
}
BEGIN { for (i = 0; i < 256; i++) ordv[sprintf("%c", i)] = i; consumed = 0; cnt = 0; }
NR > 1 { flush(prev) }                     # prev is always complete
{ prev = $0 }
END {
  if (ends_nl == 1 && NR >= 1) flush(prev);  # last complete line
  print cnt + 0 > countfile;
  print consumed + 0;                        # -> stdout
}
' "$RAW") || die "failed to process the log"

case "$consumed" in ''|*[!0-9]*) consumed=0 ;; esac
cnt=0
if [ -f "$CNTF" ]; then cnt=$(cat "$CNTF" 2>/dev/null); fi
case "$cnt" in ''|*[!0-9]*) cnt=0 ;; esac
newoffset=$((offset + consumed))

# ---------------------------------------------------------------------------
# write_offset: atomic write of the state.
# ---------------------------------------------------------------------------
write_offset() {
  _o=$1
  if ( set -C; printf '%s\n' "$_o" > "$STATE.tmp" ) 2>/dev/null; then
    :
  elif printf '%s\n' "$_o" > "$STATE.tmp" 2>/dev/null; then
    :
  else
    die "could not write the state to $STATE (directory permissions?)"
  fi
  mv -f "$STATE.tmp" "$STATE" 2>/dev/null || die "could not update $STATE"
}

# No lure lines in the new data: advance the offset (it was real traffic) and exit.
if [ "$cnt" -eq 0 ]; then
  if [ "$MOQESH_DRY_RUN" = "1" ]; then
    info "[dry-run] $consumed new bytes, 0 lure lines; nothing to send (offset $offset -> $newoffset)"
    exit 0
  fi
  write_offset "$newoffset"
  info "0 lure lines; offset $offset -> $newoffset"
  exit 0
fi

fmt_esc=$(json_scalar "$MOQESH_FORMAT")
base_esc=$(json_scalar "$MOQESH_BASE_PATH")

# Split into batches of up to CAP lines.
CHUNKD="$TMPD/chunks"
mkdir -p "$CHUNKD"
if ! split -l "$CAP" "$ESC" "$CHUNKD/c." 2>/dev/null; then
  cp "$ESC" "$CHUNKD/c.aa"  # fallback: a single batch
fi

# ---------------------------------------------------------------------------
# build_body CHUNK BODYFILE : builds the exact JSON to sign/send.
# ---------------------------------------------------------------------------
build_body() {
  _chunk=$1; _bf=$2
  _arr=$(paste -sd, "$_chunk")
  printf '%s%s%s' \
    '{"format":"'"$fmt_esc"'","base_path":"'"$base_esc"'","lines":[' \
    "$_arr" \
    ']}' > "$_bf"
}

# ---------------------------------------------------------------------------
# 6. DRY-RUN: print what would be sent and exit (no network, no offset advance).
# ---------------------------------------------------------------------------
if [ "$MOQESH_DRY_RUN" = "1" ]; then
  info "[dry-run] server=$MOQESH_SERVER format=$MOQESH_FORMAT prefix=$MOQESH_BASE_PATH"
  info "[dry-run] offset $offset -> $newoffset ; $cnt lure lines (the offset is NOT advanced)"
  info "[dry-run] skipping /control; below are the bodies that would be sent:"
  _i=0
  for _chunk in "$CHUNKD"/c.*; do
    [ -f "$_chunk" ] || continue
    _i=$((_i + 1))
    _bf="$TMPD/body.$_i"
    build_body "$_chunk" "$_bf"
    _ts=$(mq_ts)
    _sig=$(sign_file "$_ts" "$_bf")
    printf -- '--- batch %s -> POST %s/ingest/logs ---\n' "$_i" "$MOQESH_SERVER"
    printf 'X-Moqesh-Key-Id: %s\n' "$MOQESH_KEY_ID"
    printf 'X-Moqesh-Timestamp: %s\n' "$_ts"
    printf 'X-Moqesh-Signature: %s\n' "$_sig"
    cat "$_bf"
    printf '\n'
  done
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. GET /control (signed) + verification of the server's signature.
# ---------------------------------------------------------------------------
ts=$(mq_ts)
sig=$(sign_file "$ts" "$EMPTY")  # cuerpo vacio
code=$(curl -sS -o "$CBODY" -D "$HDR" -w '%{http_code}' \
  -H "X-Moqesh-Key-Id: $MOQESH_KEY_ID" \
  -H "X-Moqesh-Timestamp: $ts" \
  -H "X-Moqesh-Signature: $sig" \
  "$MOQESH_SERVER/control" 2>/dev/null) \
  || die "could not connect to $MOQESH_SERVER/control"
[ "$code" = "200" ] || die "/control returned HTTP $code"

srv_ts=$(awk -F': *' 'tolower($1)=="x-moqesh-timestamp"{v=$2} END{printf "%s", v}' "$HDR" | tr -d '\r\n')
srv_sig=$(awk -F': *' 'tolower($1)=="x-moqesh-server-signature"{v=$2} END{printf "%s", v}' "$HDR" | tr -d '\r\n')
[ -n "$srv_sig" ] || die "/control without X-Moqesh-Server-Signature"

calc=$(sign_file "$srv_ts" "$CBODY")
[ "$calc" = "$srv_sig" ] || die "INVALID server signature (possible MITM); not sending"

enabled=$(sed -n 's/.*"enabled"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$CBODY" | head -n1)
if [ "$enabled" != "true" ]; then
  # DECISION: disabled -> do not send and do NOT advance the offset (do not lose lure lines).
  info "sensor disabled (enabled=$enabled); not sending or advancing the offset ($cnt lines waiting)"
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. POST /ingest/logs in batches (signed). Offset only after full success.
# ---------------------------------------------------------------------------
sent=0
_i=0
for _chunk in "$CHUNKD"/c.*; do
  [ -f "$_chunk" ] || continue
  _i=$((_i + 1))
  _bf="$TMPD/body.$_i"
  build_body "$_chunk" "$_bf"
  _ts=$(mq_ts)
  _sig=$(sign_file "$_ts" "$_bf")
  _resp="$TMPD/resp.$_i"
  code=$(curl -sS -o "$_resp" -w '%{http_code}' -X POST \
    -H "Content-Type: application/json" \
    -H "X-Moqesh-Key-Id: $MOQESH_KEY_ID" \
    -H "X-Moqesh-Timestamp: $_ts" \
    -H "X-Moqesh-Signature: $_sig" \
    --data-binary @"$_bf" \
    "$MOQESH_SERVER/ingest/logs" 2>/dev/null) \
    || die "network failure sending batch $_i (offset not advanced)"
  case "$code" in
    2*) sent=$((sent + 1)) ;;
    *)  die "ingest returned HTTP $code in batch $_i (offset not advanced)" ;;
  esac
done

# All batches OK -> now we advance the offset.
write_offset "$newoffset"
info "sent $cnt lure lines in $sent batch(es); offset $offset -> $newoffset"
exit 0
