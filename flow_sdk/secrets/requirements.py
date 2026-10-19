"""What a consumer declares it needs from a store: the names, in declaration order."""
from __future__ import annotations

from typing import Iterable


class SecretRequirements:
    """``consumer.credentials`` — ``names()`` is the list a store is validated against."""

    def __init__(self, names: Iterable[str] = ()) -> None:
        self._names = tuple(dict.fromkeys(names))

    def names(self) -> list[str]:
        return list(self._names)

    def __repr__(self) -> str:
        return f"SecretRequirements({list(self._names)})"


__all__ = ["SecretRequirements"]
