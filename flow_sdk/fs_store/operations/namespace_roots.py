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

#: ``ns -> project root``, as the indexing paths have reported it.
_ROOTS: dict[str, Path] = {}

#: The namespaces whose driver folders have already been imported in this process.
#: Lives beside the map rather than in the driver registry because it is a property
#: OF the map — "we have acted on this entry" — and splitting the two across modules
#: meant dropping one had to reach into the other to drop the rest.
_LOADED: set[str] = set()


def root_for(ns: str) -> Optional[Path]:
    """The project that owns ``ns``, or None — SYNCHRONOUS, cache read only.

    None covers both "not built yet" and "unknown namespace", deliberately: the caller
    does the same thing either way (register nothing, leave the kind anonymous), and
    collapsing them keeps this readable from inside a validator.
    """
    return _ROOTS.get(ns) if ns else None


def claim_unloaded(ns: str) -> Optional[Path]:
    """``ns``'s project root the FIRST time it is asked for, else None.

    One call so that "where is it" and "have we already imported it" cannot be asked
    in the wrong order. A namespace with no known root is NOT claimed: the map may
    simply not be filled yet, and recording it as done would leave that namespace
    unreadable for the life of the process.
    """
    if not ns or ns in _LOADED:
        return None
    root = _ROOTS.get(ns)
    if root is not None:
        _LOADED.add(ns)
    return root


def remember(ns: str, root: Path) -> None:
    """Record one project's namespace, from a path that has already read its manifest."""
    if not ns:
        return
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
    """Drop the map (a project was removed, renamed, or its manifest rewritten).

    Clears what has been loaded too: the two are one fact, and keeping the "already
    imported" half would leave a moved project's folders permanently unreachable.
    """
    _ROOTS.clear()
    _LOADED.clear()
