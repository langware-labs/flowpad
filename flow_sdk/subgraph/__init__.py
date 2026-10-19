"""Entity-subgraph projections — the reusable layer between the graph engine
and feature views.

A *projection* is a named builder that derives a GraphPayload (nodes + edges in
the shape ``ui``'s ``graphFromPayload`` consumes) from the entity world at
query time. Features register one builder and get a rendered, navigable graph
for free at ``/dock/subgraph/<name>`` (or their own thin view type on the same
surface — see the tag view).

The payload contract is deliberately LENIENT dicts, not the strict worldview
pydantic models: subgraphs may contain ghost nodes with non-uuid ids and
custom keys (anonymous tags, code files), which the worldview validator
rejects by design.

The registry below is the whole mechanism: a name → builder dict plus the
built-in loader. ``register_builtin_projections`` is the chokepoint (same shape
as ``schema/type_info.register_all``) so the generic route never has to know
its consumers.
"""
from __future__ import annotations

from typing import Awaitable, Callable

from .payload import edge, node, validate_payload

# params are raw query-string values (string-in); each builder parses its own.
SubgraphBuilder = Callable[[dict[str, str]], Awaitable[dict]]

_projections: dict[str, SubgraphBuilder] = {}
_builtins_loaded = False


def register_projection(name: str, builder: SubgraphBuilder) -> None:
    """Register (or replace — modules re-import in tests) a named projection."""
    _projections[name] = builder


def get_projection(name: str) -> SubgraphBuilder | None:
    return _projections.get(name)


def known_projections() -> list[str]:
    return sorted(_projections)


def register_builtin_projections() -> None:
    """Import every module that registers a built-in projection. Idempotent."""
    global _builtins_loaded
    if _builtins_loaded:
        return
    _builtins_loaded = True
    import flow_sdk.tags.graph  # noqa: F401, PLC0415 — registers "tag"


__all__ = [
    "SubgraphBuilder",
    "edge",
    "get_projection",
    "known_projections",
    "node",
    "register_builtin_projections",
    "register_projection",
    "validate_payload",
]
