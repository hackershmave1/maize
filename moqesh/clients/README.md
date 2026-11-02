# Moqesh - Agentless shippers

Shipping scripts **with no heavy software to install**. They run from
cron (POSIX) or a Scheduled Task (Windows), read the web server's access log,
keep **only the lines that match the lure prefix** and send them
signed (HMAC) to the Moqesh server.

- `moqesh-ship.sh`: POSIX `sh`. Needs only `curl`, `openssl` and `awk`.
- `moqesh-ship.ps1`: PowerShell 5+ (Windows), no external dependencies.

Both are **idempotent** (a byte offset into the log avoids resends; the server
also deduplicates) and **never** modify or delete the source log.

## Privacy

The script sends **only** the lines whose content includes
`MOQESH_BASE_PATH` (the lure prefix). Real user traffic never
leaves the host. That is why `MOQESH_BASE_PATH` is required: without a prefix the whole
log would be sent, so the script refuses to run.

## Environment variables

| Variable           | Req. | Description                                                         |
|--------------------|:----:|---------------------------------------------------------------------|
| `MOQESH_SERVER`    | yes  | Base URL of the Moqesh server (e.g. `https://moqesh.example.com`).  |
| `MOQESH_KEY_ID`    | yes  | The sensor's key identifier.                                        |
| `MOQESH_SECRET`    | yes  | The sensor's HMAC secret (keep it private).                         |
| `MOQESH_LOG`       | yes  | Path to the access log (e.g. `/var/log/nginx/access.log`).          |
| `MOQESH_BASE_PATH` | yes  | Lure prefix (e.g. `/lure`).                                         |
| `MOQESH_FORMAT`    |  no  | `nginx` \| `apache` \| `caddy` \| `json` \| `raw`. Default `nginx`. |
| `MOQESH_STATE`     |  no  | Offset file. Default: next to the script, unique per log path.      |
| `MOQESH_DRY_RUN`   |  no  | `1` = print what would be sent and exit (touches neither the network nor the offset). |

## Behavior

1. **Offset + rotation**: stores the byte offset read so far. If the log's current
   size is smaller than the stored offset (rotation/truncation), it resets to `0`. Only
   the new lines since the offset are read. The last line without `\n` (possibly
   half-written) is left pending for the next run.
2. **Filtering** by `MOQESH_BASE_PATH` (see *Privacy*).
3. Signed **`GET /control`**. The **server's signature is verified**
   (`X-Moqesh-Server-Signature`) before trusting the response; if it does not match, the
   script aborts without sending (anti-MITM protection).
4. If `enabled=false`: **nothing is sent and the offset is NOT advanced** (a design
   decision), so lure lines are not lost when the sensor is re-enabled. Meanwhile the
   script re-reads those same lines on every run, but they **do not leave the
   host** until the sensor is re-enabled.
5. Signed **`POST /ingest/logs`**, in batches of up to **20,000 lines** per send.
   The offset only advances after **all** batches succeed.
6. Lines that do not match the prefix (real traffic) do advance the offset
   so they are not rescanned, but they are never sent.

### Signature (identical to `moqesh/security.py`)

```
ts        = <unix epoch with decimals, as a string>
message   = ts + "." + <exact body>             # empty body on GET /control
signature = "sha256=" + HMAC_SHA256_hex(MOQESH_SECRET, message)
```

Headers: `X-Moqesh-Key-Id`, `X-Moqesh-Timestamp`, `X-Moqesh-Signature`.

## Example: cron (POSIX, every 5 minutes)

It is better to put the secrets in an environment file with `600` permissions instead
of leaving them in the crontab:

```sh
# /opt/moqesh/ship.env   (chmod 600)
export MOQESH_SERVER=https://moqesh.example.com
export MOQESH_KEY_ID=mq_xxxxxxxxxxxxxxxx
export MOQESH_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export MOQESH_LOG=/var/log/nginx/access.log
export MOQESH_BASE_PATH=/lure
export MOQESH_FORMAT=nginx
```

```cron
# crontab -e
*/5 * * * * . /opt/moqesh/ship.env && /opt/moqesh/moqesh-ship.sh >> /var/log/moqesh-ship.log 2>&1
```

Or all on one line (as the provisioning wizard generates it):

```cron
*/5 * * * * MOQESH_SERVER=https://moqesh.example.com MOQESH_KEY_ID=mq_... MOQESH_SECRET=... MOQESH_LOG=/var/log/nginx/access.log MOQESH_BASE_PATH=/lure /opt/moqesh/moqesh-ship.sh >/dev/null 2>&1
```

## Example: Scheduled Task (Windows, every 5 minutes)

```powershell
# Run once as administrator to register the task.
$envBlock = @'
$env:MOQESH_SERVER   = "https://moqesh.example.com"
$env:MOQESH_KEY_ID   = "mq_xxxxxxxxxxxxxxxx"
$env:MOQESH_SECRET   = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
$env:MOQESH_LOG      = "C:\logs\access.log"
$env:MOQESH_BASE_PATH= "/lure"
$env:MOQESH_FORMAT   = "nginx"
& "C:\moqesh\moqesh-ship.ps1"
'@
Set-Content -Path C:\moqesh\run-ship.ps1 -Value $envBlock -Encoding UTF8

$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
           -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\moqesh\run-ship.ps1'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
           -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "Moqesh Shipper" -Action $action -Trigger $trigger `
           -RunLevel Highest -Description "Agentless shipping of lure logs to Moqesh"
```

> Protect `run-ship.ps1` with a restrictive ACL: it contains the secret.

## Dry run

Always do a dry run before scheduling the task:

```sh
MOQESH_SERVER=https://moqesh.example.com MOQESH_KEY_ID=mq_... MOQESH_SECRET=... \
MOQESH_LOG=/var/log/nginx/access.log MOQESH_BASE_PATH=/lure MOQESH_DRY_RUN=1 \
  sh /opt/moqesh/moqesh-ship.sh
```

It prints the exact JSON body (or bodies) and the signed headers that would be sent,
**without** contacting the server and **without** advancing the offset. Check that:

- only lure lines appear (none from real traffic),
- the format (`MOQESH_FORMAT`) matches your web server.

## Signature parity check (done)

The scripts' HMAC signature was verified to match `moqesh.security.sign`
**byte for byte**:

```sh
# POSIX / openssl  (what sign_file does in moqesh-ship.sh)
SECRET=...; TS=1760000000.123; BODY='{"format":"nginx",...}'
{ printf '%s.' "$TS"; printf '%s' "$BODY"; } | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}'

# Python reference
python -c "from moqesh import security; print(security.sign('$SECRET','$TS', b'...'))"
```

Result: identical for a full body and for an empty body (GET `/control`),
even with secrets that start with `-` (e.g. from `token_urlsafe`). The PowerShell
version (`HMACSHA256` over `UTF8(ts + "." + body)`) produces the same hash.
In addition, the JSON body generated by both scripts was parsed with
`moqesh.logparse.parse`, and verification of `X-Moqesh-Server-Signature` was tested
against a response signed with `moqesh.security.sign` (including a tampering test that
is correctly rejected).

## Security note

On POSIX the secret is passed to `openssl dgst -hmac` as an argument; it is briefly
visible in the host's own process list. It is the same secret that already
lives in the cron environment; keep the host and the environment file with
restrictive permissions.
