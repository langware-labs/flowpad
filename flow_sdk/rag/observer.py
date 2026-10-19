"""Tell a ``RagIndex`` that something it covers has changed.

This is the whole of RAG's involvement in the indexer path, and it is deliberately tiny: one
containment test and, at most, one field write. No chunking, no embedding, no network. A scan
of a thousand documents must not make a paid call, and a provider being down must not stall a
walk — so the indexer only records that there is work, and the background pass decides what.

**It writes at most once per index per idle period.** ``pending`` is only ever flipped
false→true here, so the second and subsequent documents of a folder cost a containment test and
nothing else. A marker that wrote a row per document would turn a scan into a write storm for a
flag whose value never changed after the first one.

**Missing a mark is survivable.** The reconciler also compares each root's recorded hash against
the tree's, so an unmarked change is found on the next pass rather than lost. That is what lets
this stay a fire-and-forget observer whose failures are logged and swallowed.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flow_sdk.fs_store.fs_record import FSRecord

logger = logging.getLogger(__name__)


async def mark_rag_stale(record: "FSRecord") -> None:
    """Post-sync observer: flag the index covering this record, if any.

    Registered on every type whose documents a RAG index can hold. Reads the record's own
    ``project_id`` so the lookup is scoped to one project rather than scanning every index on
    the box for every file in a walk.
    """
    path = str(getattr(getattr(record, "asset_ref", None), "path", "") or "")
    if not path:
        return

    from flow_sdk.builtin.rag_index import RagIndex  # noqa: PLC0415

    project_id = str(getattr(record, "project_id", "") or "") or None
    index = await RagIndex.covering(path, project_id=project_id)
    if index is None or index.pending:
        # Already flagged: the rest of this folder's documents cost one comparison each.
        return

    index.pending = True
    # ``notify=False``: a staleness flag is not news anybody's screen is waiting on, and a
    # broadcast per indexed folder would be noise on the same socket the walk is reporting
    # progress over.
    await index.save(notify=False)
    logger.debug("rag: %s marked pending by %s", index.id, path)


__all__ = ["mark_rag_stale"]
