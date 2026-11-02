"""Forge for decoy binaries with embedded credentials.

Strategy (chosen to avoid a runtime .NET dependency): start from a
**.NET DLL template pre-forged offline** (see `tools/build_template_dll.md`) that
contains fixed-width placeholder literals; at runtime the **bytes are patched**
(UTF-16LE of the string heap) with the deployment's real values, without recompiling.
The result is a valid, decompilable .NET DLL (dnSpy/ILSpy).

If the template is missing (e.g. an environment without the artifact), it degrades to a
decoy binary with a PE header and the credentials embedded in cleartext: an agent that
downloads it and runs `strings`/decompile still finds the lure. It never breaks.
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass

logger = logging.getLogger("moqesh.forge")

# Default template (if present). Can be generated offline with the .NET build.
_DEFAULT_TEMPLATE = os.path.join(os.path.dirname(__file__), "assets", "portal_template.dll")

# Fixed-width placeholder literals the template must contain (ASCII).
# Patching respects their exact length so PE metadata does not shift.
_PLACEHOLDERS = {
    "connection_string": "MQCONN__" + "0" * 120,  # 128 chars
    "internal_api_base": "MQAPI__" + "0" * 57,  # 64 chars
    "bearer_token": "MQBEARER__" + "0" * 118,  # 128 chars
}
_B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"


@dataclass(frozen=True)
class ForgeInput:
    assembly_name: str
    namespace: str
    connection_string: str
    internal_api_base: str
    bearer_token: str


def _safe_name(s: str) -> str:
    cleaned = "".join(c for c in (s or "") if c.isalnum() or c == ".")
    return cleaned or "Portal"


def _pad(value: str, width: int, salt: bytes) -> str:
    """Fit `value` to `width` chars: truncate if too long, or pad with base62
    derived from the salt (looks like a longer secret; the real marker stays as a prefix)."""
    if len(value) >= width:
        return value[:width]
    need = width - len(value)
    fill = "".join(_B62[b % len(_B62)] for b in hashlib.sha256(salt).digest())
    while len(fill) < need:
        fill += "".join(_B62[b % len(_B62)] for b in hashlib.sha256(fill.encode()).digest())
    return value + fill[:need]


class AssemblyForge:
    """Forges decoy DLLs by patching a template; caches by key."""

    def __init__(self, template_path: str | None = None) -> None:
        self._template_path = template_path or _DEFAULT_TEMPLATE
        self._cache: dict[str, bytes] = {}
        self._warned = False

    def forge(self, cache_key: str, inp: ForgeInput) -> tuple[bytes, str]:
        if cache_key not in self._cache:
            self._cache[cache_key] = self._build(cache_key, inp)
        filename = _safe_name(inp.assembly_name)
        if not filename.lower().endswith(".dll"):
            filename += ".dll"
        return self._cache[cache_key], filename

    def _build(self, cache_key: str, inp: ForgeInput) -> bytes:
        template = self._load_template()
        if template is not None:
            return self._patch(template, cache_key, inp)
        if not self._warned:
            logger.warning(
                "DLL template missing (%s): serving a decoy PE binary with embedded "
                "credentials. Generate the template offline for a decompilable .NET DLL.",
                self._template_path,
            )
            self._warned = True
        return self._decoy_pe(cache_key, inp)

    def _load_template(self) -> bytes | None:
        try:
            with open(self._template_path, "rb") as fh:
                return fh.read()
        except OSError:
            return None

    def _patch(self, template: bytes, cache_key: str, inp: ForgeInput) -> bytes:
        buf = bytearray(template)
        values = {
            "connection_string": inp.connection_string,
            "internal_api_base": inp.internal_api_base,
            "bearer_token": inp.bearer_token,
        }
        for field_name, placeholder in _PLACEHOLDERS.items():
            value = _pad(values[field_name], len(placeholder), f"{cache_key}:{field_name}".encode())
            needle = placeholder.encode("utf-16-le")
            repl = value.encode("utf-16-le")
            i = buf.find(needle)
            if i >= 0 and len(repl) == len(needle):
                buf[i : i + len(needle)] = repl
            else:
                logger.debug("Placeholder '%s' not found in the template; skipping.", field_name)
        return bytes(buf)

    @staticmethod
    def _decoy_pe(cache_key: str, inp: ForgeInput) -> bytes:
        h = hashlib.sha256(cache_key.encode()).digest()
        size = 8192 + h[0] * 32
        buf = bytearray(size)
        # Plausible DOS/PE header (file(1) recognizes it as a PE executable, not ELF).
        buf[0:2] = b"MZ"
        buf[0x3C:0x40] = (0x80).to_bytes(4, "little")  # e_lfanew -> PE offset
        buf[0x80:0x84] = b"PE\x00\x00"
        for i in range(0x84, size):
            buf[i] = h[i % len(h)]
        # Credentials embedded in cleartext (recoverable with `strings`/decompilation).
        blob = (
            "\x00AppConfig\x00ConnectionString\x00"
            + inp.connection_string
            + "\x00InternalApiBase\x00"
            + inp.internal_api_base
            + "\x00ServiceToken\x00"
            + inp.bearer_token
            + "\x00"
        ).encode("utf-8", "ignore")
        off = 0x200
        buf[off : off + len(blob)] = blob
        return bytes(buf)
