# Security policy

MAIZE is a **defensive** tool (honeypot/deception). We appreciate responsible
disclosure of vulnerabilities.

## Reporting a vulnerability

- Do **not** open a public issue.
- Use the repository's private **GitHub Security Advisories**
  (the *Security → Report a vulnerability* tab).
- Include the version/commit, reproduction steps and the impact. We reply as soon as possible
  and coordinate disclosure after a fix.

## Threat model and design decisions

The assumptions below describe inherited Moqesh components. MAIZE's current
Cloudflare deployment does not run remote sensors or the Python server; see
[`cloudflare/README.md`](cloudflare/README.md) for Worker containment,
Access protection, secret handling, and retention.

By definition, Moqesh is deployed in hostile environments. Key assumptions:

- The **honeypot is attacked on purpose**. The lure content (AWS/JWT/DB keys,
  decoy binaries) is **inert**: it does not correspond to real credentials and executes nothing.
- **Remote sensors** may live on servers that get compromised. That is why their
  key is **least privilege** (only ingestion + control of its own sensor),
  **revocable/rotatable** in one click, and ingestion is always treated as **hostile**
  (validation, rate limiting, dedup, prefix filtering).
- The sensor<->server channel uses **HMAC signed in both directions** (including the
  control responses) + an anti-replay window, so a MITM cannot forge deliveries
  or shutdown orders. Deploy the server behind **TLS**.
- Agentless mode sends **only the lure lines** (prefix filter) so it does not
  exfiltrate real user traffic; use the **dry run** before enabling it.

## Responsible use

Deploy sensors only on infrastructure you are **authorized** to protect.
Isolate the lure path from the real paths and apply the safe-serving config included
in each bundle (it serves the content as data, never as code).
