"""Which project owns an ontology namespace — the one map a SYNCHRONOUS reader may ask.

A kind carries whose it is (``--acme--.ingest.message.x``), and restoring that value
means importing the code that declared the class. The import needs a FOLDER, and the
only place a namespace is written down is a project's manifest — a row in the database.

That is the whole problem this module exists for: ``SchemaRegistry.kind_type`` runs
inside a pydantic validator, hydrating a row. It cannot await, so it cannot ask the
database anything. So the answer is kept here, filled from the paths that already
await (the manifest's own post-sync hook, project creation, the boot sweep) and read
synchronously by the loader.

It is a CACHE of a fact on disk, never the fact itself: an empty map means "nobody has
told us yet", not "no such namespace". A miss is therefore never memoized as absent —
the next read asks again, and answers as soon as the indexer has been past.

Note there is no "load them all" verb, deliberately. Enumerating every ``ProjectManifest``
row would be an unscoped ``get_all()`` — the thing ``test_query_scope_policy`` freezes —
and it is not needed: the paths that already read a project's manifest (the boot sweep,
project creation, the manifest's post-sync hook) each ``remember`` the one they read.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

#: ``ns -> project root``. ``None`` = never built; ``{}`` = built and empty.
_ROOTS: Optional[dict[str, Path]] = None


def root_for(ns: str) -> Optional[Path]:
    """The project that owns ``ns``, or None — SYNCHRONOUS, cache read only.

    None covers both "not built yet" and "unknown namespace", deliberately: the caller
    does the same thing either way (register nothing, leave the kind anonymous), and
    collapsing them keeps this readable from inside a validator.
    """
    return (_ROOTS or {}).get(ns) if ns else None


def remember(ns: str, root: Path) -> None:
    """Record one project's namespace, from a path that has already read its manifest."""
    global _ROOTS
    if not ns:
        return
    if _ROOTS is None:
        _ROOTS = {}
    known = _ROOTS.get(ns)
    if known == Path(root):
        return
    if known is not None:
        # Two projects claiming one namespace is legal — a namespace is an unvalidated
        # claim — but only one folder can answer for it here. Say so rather than flip
        # silently between them on every re-index.
        logger.warning("[namespace] %r is claimed by %s and %s; keeping %s", ns, known, root, known)
        return
    _ROOTS[ns] = Path(root)


def invalidate() -> None:
    """Drop the map (a project was removed, renamed, or its manifest rewritten)."""
    global _ROOTS
    _ROOTS = None
    from flow_sdk.ingest.driver_registry import forget_namespace_loads  # noqa: PLC0415 — cycle

    forget_namespace_loads()
