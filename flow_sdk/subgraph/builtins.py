"""Built-in subgraph projections — the one place that names them.

Import side effects register; this module is the chokepoint (same shape as
``schema/type_info.register_all``), so the generic route never has to know
its consumers.
"""
from __future__ import annotations

_loaded = False


def register_builtin_projections() -> None:
    """Idempotent. Safe to call at startup and from tests."""
    global _loaded
    if _loaded:
        return
    _loaded = True
    import flow_sdk.topics.graph  # noqa: F401, PLC0415 — registers "topic"
