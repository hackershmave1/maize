"""Deterministic RNG per (seed, path): the anti-fingerprint primitive.

Derives a pseudorandom sequence from `SHA-256(seed + "\\0" + path)` and
extends it by re-hashing the state. Key property:

- **Stable**: the same (seed, path) ALWAYS produces the same output -> a labyrinth
  node does not reveal randomness across requests.
- **Unique per deployment**: another seed completely changes names, paths,
  tokens and banners -> two installations share no static signature.

This is not a cryptographic RNG; it is a reproducible deterministic generator.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from typing import TypeVar

T = TypeVar("T")

_UINT_MAX = 0xFFFFFFFF
_HEX = "0123456789abcdef"
_ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"


class SeededRandom:
    """Deterministic byte stream derived from (seed, path)."""

    __slots__ = ("_state", "_pos")

    def __init__(self, seed: str, path: str) -> None:
        self._state = hashlib.sha256(f"{seed}\x00{path}".encode()).digest()
        self._pos = 0

    def _byte(self) -> int:
        if self._pos >= len(self._state):
            self._state = hashlib.sha256(self._state).digest()
            self._pos = 0
        b = self._state[self._pos]
        self._pos += 1
        return b

    def _u32(self) -> int:
        v = 0
        for _ in range(4):
            v = ((v << 8) | self._byte()) & _UINT_MAX
        return v

    def below(self, n: int) -> int:
        """Integer in [0, n)."""
        return 0 if n <= 1 else self._u32() % n

    def between(self, lo: int, hi: int) -> int:
        """Integer in [lo, hi)."""
        return lo + self.below(hi - lo)

    def real(self) -> float:
        """Float in [0, 1]."""
        return self._u32() / _UINT_MAX

    def chance(self, p: float) -> bool:
        return self.real() < p

    def pick(self, items: Sequence[T]) -> T:
        return items[self.below(len(items))]

    def hex(self, length: int) -> str:
        return "".join(_HEX[self.below(16)] for _ in range(length))

    def alnum(self, length: int) -> str:
        return "".join(_ALNUM[self.below(len(_ALNUM))] for _ in range(length))
