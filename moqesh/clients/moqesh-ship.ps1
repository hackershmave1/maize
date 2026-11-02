<#
  moqesh-ship.ps1 - Moqesh agentless shipper (PowerShell 5+).

  Runs as a Scheduled Task on the customer's server. Reads the web server's
  access log, keeps ONLY the lines that match the lure prefix
  (privacy: real user traffic never leaves the host) and sends them
  HMAC-signed to the Moqesh server. Installs no heavy software.

  Idempotent: stores a byte offset into the log; the server also deduplicates.
  NEVER modifies or deletes the source log.

  Environment variables (see moqesh/clients/README.md):
    MOQESH_SERVER     base URL of the Moqesh server          (required)
    MOQESH_KEY_ID     the sensor's key identifier            (required)
    MOQESH_SECRET     the sensor's HMAC secret               (required)
    MOQESH_LOG        path to the access log                 (required)
    MOQESH_BASE_PATH  lure prefix, e.g. /lure                (required)
    MOQESH_FORMAT     nginx|apache|caddy|json|raw            (default nginx)
    MOQESH_STATE      offset file                            (default: next to the script)
    MOQESH_DRY_RUN    1 = print what would be sent and exit  (default empty)

  Documented decision: if /control returns enabled=false, nothing is sent and the
  offset is NOT advanced, so lure lines are not lost when the sensor is re-enabled.
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# TLS 1.2 for HTTPS on older Windows versions.
try {
  [System.Net.ServicePointManager]::SecurityProtocol = `
    [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
} catch { }

$CAP = 20000  # cap on lines per send (the server also caps at 20000)

function Die([string]$msg) { [Console]::Error.WriteLine("moqesh-ship: $msg"); exit 1 }
function Info([string]$msg) { Write-Host "moqesh-ship: $msg" }

# ---------------------------------------------------------------------------
# 1. Environment and validation
# ---------------------------------------------------------------------------
$server   = $env:MOQESH_SERVER
$keyId    = $env:MOQESH_KEY_ID
$secret   = $env:MOQESH_SECRET
$log      = $env:MOQESH_LOG
$basePath = $env:MOQESH_BASE_PATH
$fmt      = $env:MOQESH_FORMAT; if ([string]::IsNullOrEmpty($fmt)) { $fmt = 'nginx' }
$dryRun   = ($env:MOQESH_DRY_RUN -eq '1')

if ([string]::IsNullOrEmpty($server))   { Die 'MOQESH_SERVER is missing' }
if ([string]::IsNullOrEmpty($keyId))    { Die 'MOQESH_KEY_ID is missing' }
if ([string]::IsNullOrEmpty($secret))   { Die 'MOQESH_SECRET is missing' }
if ([string]::IsNullOrEmpty($log))      { Die 'MOQESH_LOG is missing' }
# Empty prefix = ALL traffic would be sent -> forbidden for privacy.
if ([string]::IsNullOrEmpty($basePath)) { Die 'MOQESH_BASE_PATH is missing (without a prefix, real traffic would be sent)' }

$server = $server.TrimEnd('/')  # no trailing slash -> avoids //control

# Default state: unique per log path.
$state = $env:MOQESH_STATE
if ([string]::IsNullOrEmpty($state)) {
  $selfDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  if ([string]::IsNullOrEmpty($selfDir)) { $selfDir = '.' }
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $h = ($md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($log)) | ForEach-Object { $_.ToString('x2') }) -join ''
  $state = Join-Path $selfDir (".moqesh-ship-" + $h.Substring(0, 8) + ".state")
}

$secretBytes = [System.Text.Encoding]::UTF8.GetBytes($secret)

# ---------------------------------------------------------------------------
# Signing helpers
# ---------------------------------------------------------------------------

# Unix timestamp with decimals, invariant culture (always a dot).
function Get-MoqeshTs {
  $ms = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  return ($ms / 1000.0).ToString('F3', [System.Globalization.CultureInfo]::InvariantCulture)
}

# "sha256=<hex>" over  ts + "." + body   (identical to moqesh.security.sign).
function Get-MoqeshSignature([string]$ts, [byte[]]$bodyBytes) {
  $prefix = [System.Text.Encoding]::UTF8.GetBytes($ts + '.')
  $msg = New-Object byte[] ($prefix.Length + $bodyBytes.Length)
  [System.Array]::Copy($prefix, 0, $msg, 0, $prefix.Length)
  if ($bodyBytes.Length -gt 0) {
    [System.Array]::Copy($bodyBytes, 0, $msg, $prefix.Length, $bodyBytes.Length)
  }
  $hmac = New-Object System.Security.Cryptography.HMACSHA256
  $hmac.Key = $secretBytes
  $hash = $hmac.ComputeHash($msg)
  $hex = ($hash | ForEach-Object { $_.ToString('x2') }) -join ''
  return 'sha256=' + $hex
}

# Escape a string as a JSON literal (quotes included).
function ConvertTo-JsonLiteral([string]$s) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append([char]34)
  foreach ($ch in $s.ToCharArray()) {
    $code = [int][char]$ch
    if     ($ch -eq [char]34) { [void]$sb.Append('\"') }
    elseif ($ch -eq [char]92) { [void]$sb.Append('\\') }
    elseif ($code -eq 8)      { [void]$sb.Append('\b') }
    elseif ($code -eq 9)      { [void]$sb.Append('\t') }
    elseif ($code -eq 10)     { [void]$sb.Append('\n') }
    elseif ($code -eq 12)     { [void]$sb.Append('\f') }
    elseif ($code -eq 13)     { [void]$sb.Append('\r') }
    elseif ($code -lt 32)     { [void]$sb.Append(('\u{0:x4}' -f $code)) }
    else                      { [void]$sb.Append($ch) }
  }
  [void]$sb.Append([char]34)
  return $sb.ToString()
}

function Write-Offset([long]$value) {
  $tmp = $state + '.tmp'
  try {
    [System.IO.File]::WriteAllText($tmp, [string]$value, [System.Text.Encoding]::ASCII)
    Move-Item -LiteralPath $tmp -Destination $state -Force
  } catch {
    Die "could not write the state to $state (directory permissions?)"
  }
}

# ---------------------------------------------------------------------------
# 2. Offset + rotation
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $log)) { Die "the log does not exist: $log" }

$curSize = (Get-Item -LiteralPath $log).Length

$offset = 0L
if (Test-Path -LiteralPath $state) {
  try {
    $raw = (Get-Content -LiteralPath $state -Raw -ErrorAction Stop).Trim()
    [void][long]::TryParse($raw, [ref]$offset)
  } catch { $offset = 0L }
}

# Rotation / truncation: the log shrank -> start from zero.
if ($curSize -lt $offset) {
  Info "rotation detected ($curSize < $offset); resetting offset to 0"
  $offset = 0L
}

if ($curSize -eq $offset) {
  Info "no new lines (offset $offset)"
  exit 0
}

# Read only what is new since the offset, with ReadWrite sharing (does not block the web server).
$count = [int]($curSize - $offset)
$buf = New-Object byte[] $count
$fs = $null
try {
  $fs = New-Object System.IO.FileStream($log, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  [void]$fs.Seek($offset, [System.IO.SeekOrigin]::Begin)
  $readTotal = 0
  while ($readTotal -lt $count) {
    $n = $fs.Read($buf, $readTotal, $count - $readTotal)
    if ($n -le 0) { break }
    $readTotal += $n
  }
} catch {
  Die "could not read $log (permissions?): $($_.Exception.Message)"
} finally {
  if ($fs) { $fs.Close() }
}

# ---------------------------------------------------------------------------
# 3. Complete lines (the last one without '\n' stays pending) + prefix filtering.
#    consumed = bytes of ALL complete lines; only the lure lines are sent.
# ---------------------------------------------------------------------------
$lastNl = -1
for ($i = $readTotal - 1; $i -ge 0; $i--) { if ($buf[$i] -eq 10) { $lastNl = $i; break } }

$consumed = 0L
$matched = New-Object System.Collections.Generic.List[string]
if ($lastNl -ge 0) {
  $consumed = [long]($lastNl + 1)
  $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $lastNl + 1)
  foreach ($line in ($text -split "`n")) {
    $clean = $line.TrimEnd("`r")
    if ($clean.Length -eq 0) { continue }
    if ($clean.Contains($basePath)) { $matched.Add($clean) }  # lure lines only
  }
}
$newoffset = $offset + $consumed
$cnt = $matched.Count

# No lure lines: advance the offset (it was real traffic) and exit.
if ($cnt -eq 0) {
  if ($dryRun) {
    Info "[dry-run] $consumed new bytes, 0 lure lines; nothing to send (offset $offset -> $newoffset)"
    exit 0
  }
  Write-Offset $newoffset
  Info "0 lure lines; offset $offset -> $newoffset"
  exit 0
}

$fmtLit  = ConvertTo-JsonLiteral $fmt
$baseLit = ConvertTo-JsonLiteral $basePath

# Split into batches of up to CAP lines and build each JSON body.
function Build-Body([System.Collections.Generic.List[string]]$lines, [int]$start, [int]$len) {
  $parts = New-Object System.Collections.Generic.List[string]
  for ($j = $start; $j -lt ($start + $len); $j++) { $parts.Add((ConvertTo-JsonLiteral $lines[$j])) }
  $arr = [string]::Join(',', $parts)
  return '{"format":' + $fmtLit + ',"base_path":' + $baseLit + ',"lines":[' + $arr + ']}'
}

$batches = New-Object System.Collections.Generic.List[string]
$pos = 0
while ($pos -lt $cnt) {
  $len = [Math]::Min($CAP, $cnt - $pos)
  $batches.Add((Build-Body $matched $pos $len))
  $pos += $len
}

# ---------------------------------------------------------------------------
# 6. DRY-RUN: print what would be sent and exit (no network, no offset advance).
# ---------------------------------------------------------------------------
if ($dryRun) {
  Info "[dry-run] server=$server format=$fmt prefix=$basePath"
  Info "[dry-run] offset $offset -> $newoffset ; $cnt lure lines (the offset is NOT advanced)"
  Info "[dry-run] skipping /control; below are the bodies that would be sent:"
  for ($b = 0; $b -lt $batches.Count; $b++) {
    $body = $batches[$b]
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $ts = Get-MoqeshTs
    $sig = Get-MoqeshSignature $ts $bodyBytes
    Write-Host ("--- batch {0} -> POST {1}/ingest/logs ---" -f ($b + 1), $server)
    Write-Host ("X-Moqesh-Key-Id: {0}" -f $keyId)
    Write-Host ("X-Moqesh-Timestamp: {0}" -f $ts)
    Write-Host ("X-Moqesh-Signature: {0}" -f $sig)
    Write-Host $body
  }
  exit 0
}

# ---------------------------------------------------------------------------
# 4. GET /control (signed) + verification of the server's signature.
# ---------------------------------------------------------------------------
$ts = Get-MoqeshTs
$sig = Get-MoqeshSignature $ts (New-Object byte[] 0)  # empty body
$ctrlHeaders = @{
  'X-Moqesh-Key-Id'    = $keyId
  'X-Moqesh-Timestamp' = $ts
  'X-Moqesh-Signature' = $sig
}
try {
  $resp = Invoke-WebRequest -Uri "$server/control" -Method Get -Headers $ctrlHeaders -UseBasicParsing
} catch {
  Die "could not connect to $server/control: $($_.Exception.Message)"
}
if ([int]$resp.StatusCode -ne 200) { Die "/control returned HTTP $($resp.StatusCode)" }

# Exact body bytes, for re-signing.
$respBytes = $null
try {
  $ms = New-Object System.IO.MemoryStream
  $resp.RawContentStream.CopyTo($ms)
  $respBytes = $ms.ToArray()
} catch {
  $respBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$resp.Content)
}

$srvTs  = @($resp.Headers['X-Moqesh-Timestamp'])[0]
$srvSig = @($resp.Headers['X-Moqesh-Server-Signature'])[0]
if ([string]::IsNullOrEmpty($srvSig)) { Die '/control without X-Moqesh-Server-Signature' }

$calc = Get-MoqeshSignature $srvTs $respBytes
if ($calc -ne $srvSig) { Die 'INVALID server signature (possible MITM); not sending' }

$respText = [System.Text.Encoding]::UTF8.GetString($respBytes)
$enabled = $false
if ($respText -match '"enabled"\s*:\s*(true|false)') { $enabled = ($matches[1] -eq 'true') }
if (-not $enabled) {
  # DECISION: disabled -> do not send and do NOT advance the offset (do not lose lure lines).
  Info "sensor disabled (enabled=false); not sending or advancing the offset ($cnt lines waiting)"
  exit 0
}

# ---------------------------------------------------------------------------
# 5. POST /ingest/logs in batches (signed). Offset only after full success.
# ---------------------------------------------------------------------------
$sent = 0
for ($b = 0; $b -lt $batches.Count; $b++) {
  $body = $batches[$b]
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $ts = Get-MoqeshTs
  $sig = Get-MoqeshSignature $ts $bodyBytes
  $headers = @{
    'X-Moqesh-Key-Id'    = $keyId
    'X-Moqesh-Timestamp' = $ts
    'X-Moqesh-Signature' = $sig
  }
  try {
    $r = Invoke-WebRequest -Uri "$server/ingest/logs" -Method Post -Headers $headers `
         -ContentType 'application/json' -Body $bodyBytes -UseBasicParsing
  } catch {
    Die "failed sending batch $($b + 1) (offset not advanced): $($_.Exception.Message)"
  }
  if ([int]$r.StatusCode -lt 200 -or [int]$r.StatusCode -ge 300) {
    Die "ingest returned HTTP $($r.StatusCode) in batch $($b + 1) (offset not advanced)"
  }
  $sent++
}

# All batches OK -> now we advance the offset.
Write-Offset $newoffset
Info "sent $cnt lure lines in $sent batch(es); offset $offset -> $newoffset"
exit 0
