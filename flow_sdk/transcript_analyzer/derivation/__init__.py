"""The derivation layer — meaning added on top of transcript shape.

Public surface is deliberately two names. Everything else (the registry
internals, the worklist, the per-handler modules) is an implementation detail of
the layer, and callers outside it should not need to know a layer exists at all:
they call :func:`derive_entries` and get a list where some entries are flagged
``virtual``.

Handlers install on import so any consumer of ``derive_entries`` gets the full
set without an initialisation step it could forget.
"""

from __future__ import annotations

from .handlers import install_all
from .registry import ANY_WORKER, MAX_DERIVATION_DEPTH, derive_entries, register

install_all()

__all__ = [
    "ANY_WORKER",
    "MAX_DERIVATION_DEPTH",
    "derive_entries",
    "register",
]
