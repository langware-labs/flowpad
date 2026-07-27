"""The projection registry — name → async builder(params) → GraphPayload dict."""
from __future__ import annotations

from typing import Awaitable, Callable

# params are raw query-string values (string-in); each builder parses its own.
SubgraphBuilder = Callable[[dict[str, str]], Awaitable[dict]]

_projections: dict[str, SubgraphBuilder] = {}


def register_projection(name: str, builder: SubgraphBuilder) -> None:
    """Register (or replace — modules re-import in tests) a named projection."""
    _projections[name] = builder


def get_projection(name: str) -> SubgraphBuilder | None:
    return _projections.get(name)


def known_projections() -> list[str]:
    return sorted(_projections)
