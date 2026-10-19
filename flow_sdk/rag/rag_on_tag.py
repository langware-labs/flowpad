"""What search announces on the bus.

Follows the ``<family>_on_tag.py`` convention (see ``flow_sdk/ingest/ingest_on_tag.py``):
the family's tag strings are declared in one file rather than invented at a call site.

One tag lives here today::

    rag.runtime.missing
      target: rag_index:<id>
      data:   {reason}

It says a search pass could not load its vector index because a native runtime is missing
(on Windows, the Visual C++ Runtime). The ``install-vcredist`` wizard's own trigger listens for
it, so search never names the wizard that answers it.
"""

from __future__ import annotations

RUNTIME_MISSING_TAG = "rag.runtime.missing"


def emit_runtime_missing(index_id: str, reason: str) -> None:
    """Announce that *index_id*'s pass stopped for a missing runtime. Never raises."""
    from flow_sdk.tags import emit_tag, target_of  # noqa: PLC0415

    emit_tag(RUNTIME_MISSING_TAG, target_of("rag_index", index_id), {"reason": reason})
