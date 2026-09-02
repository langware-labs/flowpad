"""The background pass: bring stale indexes level, off the indexer's critical path.

The observer marks; this embeds. Splitting them is what keeps a scan free of paid calls and
means a provider being down delays an index rather than stalling a walk.

**The tick does no work.** It selects, guards and spawns, exactly as the ingest poller does, and
returns inside its budget. The embedding runs in its own task, because it is network-bound and
unbounded in time; doing it in the tick would block every other heartbeat task behind it.

**`pending` is a hint, not the truth.** It is cleared before the work runs, so a document
changed *during* a pass re-marks the index and is picked up next time rather than being missed.
The authority is each root's recorded hash against the tree's, which the pass compares anyway —
so a marker that never fired costs a delay, never a lost document.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from flow_sdk.server.system_heartbeat import register_heartbeat_task

if TYPE_CHECKING:
    from flow_sdk.builtin.rag_index import RagIndex
    from flow_sdk.rag.indexing import IndexReport

logger = logging.getLogger(__name__)

#: Indexes being embedded right now. One pass per index at a time: they share a store, a usearch
#: handle and a budget. Same guard, and the same reason, as the ingest poller's.
_inflight: set[str] = set()


async def embedder_for(index: "RagIndex"):
    """The embed call this index is funded by, or ``None`` when nothing funds it.

    The resolution itself lives on the entity, because the status card answers the same
    question ("is anything funding this?") and the two must never disagree.
    """
    endpoint = await index.resolve_endpoint()
    if endpoint is None:
        return None, ""

    model = index.model or endpoint.models.get("embedding", "")

    async def embed(texts):
        return await endpoint.create_embeddings(list(texts), model=model or None)

    return embed, model


async def run_index(index: "RagIndex", *, force: bool = False) -> list["IndexReport"]:
    """One pass over every root of *index*. Records what happened on the row.

    Never raises: a pass that fails leaves the reason on the row for a person to read, and the
    next tick tries again. Anything reaching the outer guard is a bug in this module, not a
    provider being unreachable.
    """
    from flow_sdk.rag.indexing import index_roots  # noqa: PLC0415

    refusal = index.index_refusal()
    if refusal:
        return []

    embed, model = await embedder_for(index)
    if embed is None:
        index.last_error = "no embedding endpoint is available on this machine"
        await index.save(notify=False)
        return []

    reports: list["IndexReport"] = []
    try:
        async with index.open_store() as store:
            reports = await index_roots(store, index.roots, embed=embed, model=model, force=force)
            index.chunk_count = store.chunk_count()
            index.document_count = len(store.document_refs())
            index.model = index.model or store.model
            index.dimensions = index.dimensions or store.dimensions
        problems = [e for r in reports for e in r.errors]
        index.last_error = problems[0] if problems else ""
    except Exception as exc:  # noqa: BLE001 — the reason belongs on the row, not in a traceback
        logger.warning("rag: pass failed for %s", index.id, exc_info=True)
        index.last_error = str(exc)
        return reports

    from datetime import datetime, timezone  # noqa: PLC0415

    if any(not r.fresh for r in reports):
        index.last_indexed_at = datetime.now(timezone.utc)
    await index.save(notify=True)
    return reports


def force_pass(index: "RagIndex") -> None:
    """Run a pass now, ignoring ``pending``.

    ``force`` re-reads every document, which is what a person asks for when they suspect the
    marks are wrong — so it cannot go through the flag the marks set. Still guarded: two passes
    over one index would contend for a single usearch handle.
    """
    key = str(index.id)
    if key in _inflight:
        return
    _inflight.add(key)
    asyncio.create_task(_run_guarded(index, force=True), name=f"rag-index-force-{index.id}")


def _spawn(index: "RagIndex") -> None:
    """Start one pass in the background.

    A named seam rather than a bare ``asyncio.create_task`` call, so a test can assert the tick
    dispatches without also running the embedding — and can do so without reaching into the
    shared ``asyncio`` module, which would break every other await in the process.
    """
    asyncio.create_task(_run_guarded(index), name=f"rag-index-{index.id}")


async def _run_guarded(index: "RagIndex", *, force: bool = False) -> None:
    try:
        await run_index(index, force=force)
    finally:
        _inflight.discard(str(index.id))


async def dispatch_due_indexes() -> list[str]:
    """Spawn a pass for every index that needs one. Returns the ids dispatched.

    Cheap by construction: ``pending`` is a field read, and the hash comparison it falls back on
    is a walk — so an index that nothing marked is only re-checked when it is not already busy.
    """
    from flow_sdk.builtin.rag_index import RagIndex, RagStatus  # noqa: PLC0415

    dispatched: list[str] = []
    # SETUP rows are included so an index minted before any key existed is promoted once one
    # does. Only MARKED ones: settling costs an endpoint lookup, and an unmarked index has
    # nothing to do even if it were promoted.
    candidates = [
        index
        for status in (RagStatus.ACTIVE, RagStatus.SETUP)
        for index in await RagIndex.get_all({"status": status.value})
    ]
    for index in candidates:
        key = str(index.id)
        if key in _inflight or not index.pending:
            continue
        if index.status == RagStatus.SETUP and await index.settle_status():
            continue
        if index.index_refusal():
            continue
        # Cleared BEFORE the work: an edit arriving mid-pass re-marks the index and is caught
        # next tick. Clearing after would swallow it.
        index.pending = False
        await index.save(notify=False)
        _inflight.add(key)
        dispatched.append(key)
        _spawn(index)
    return dispatched


@register_heartbeat_task("rag_index")
async def _heartbeat_dispatch() -> None:
    dispatched = await dispatch_due_indexes()
    if dispatched:
        logger.info("rag: dispatched %d index pass(es)", len(dispatched))


__all__ = ["dispatch_due_indexes", "embedder_for", "force_pass", "run_index"]
