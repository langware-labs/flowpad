"""The single ingestion chokepoint — record → index → emit, in that order.

Every path that brings cloud data into the graph calls ``ingest_item``: the
scheduled sweep today, a webhook relay later. Nothing else writes a
``SourceItem``. This is the same discipline as ``index_attachments`` being the
one place received bundle assets are indexed.

**The order is load-bearing and is guaranteed, not merely written down.**
``emit_tag`` is synchronous and the bus wraps coroutine handlers in
``ensure_future``, so no subscriber body can begin before this function yields.
Since the ``await entity.save(...)`` — which writes the row, the shadow metadata
and the FTS entry in one pass — has already returned by then, any TAG trigger or
flow subscription that reads the entity back, or searches for it, finds it
committed. A refactor that moves emission to the caller, or into ``save()``'s
notify path, breaks that silently: keep steps 5-7 in one function.

**The digest gate is the performance story.** An unchanged item costs one
indexed read (the natural key, via ``ix_entities_source_item_natural_key_v2``) and
nothing else — no save, no metadata.json write, no FTS write, no WS broadcast,
no event. Feeds re-serve their whole window on every
poll, so without this gate a 5-minute poller rewrites and re-announces the same
records forever.
"""
from __future__ import annotations

import logging
from typing import Optional, Sequence

from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.source_item import SourceItem, SourceItemSpec
from flow_sdk.ingest.ingest_on_tag import emit_item_tag
from flow_sdk.ingest.models import IngestMode, IngestOutcome, IngestReport

logger = logging.getLogger(__name__)



async def ingest_item(
    item: SourceItemSpec,
    *,
    owner: Optional[TypeId] = None,
    mode: IngestMode = IngestMode.INCREMENTAL,
    known: Optional[dict[tuple[str, ...], SourceItem]] = None,
) -> IngestOutcome:
    """``known`` is a pre-loaded ``{natural key: row}`` map from
    ``ingest_items``; without it this falls back to a single lookup.

    **Identity is the natural key, not the id.** The DB serializer resolves the
    row by ``(data_source, segment, external id)`` and gates on the digest; a
    genuinely new record gets an ordinary ``uuid4``. That is what makes a
    re-poll idempotent — and it works on rows written before ids were v4,
    because nothing here re-derives an id.
    """
    ser = SourceItem.serializer()
    if known is not None:
        existing = known.get(ser.natural_key_of(SourceItem, item))
    else:
        existing = await ser.resolve(SourceItem, item)

    row, status = ser.upsert(SourceItem, item, existing=existing)
    if row is None:
        return IngestOutcome(entity_id=str(existing.id), external_id=item.external_id, status="unchanged")

    # ── record + index ────────────────────────────────────────────────────
    # save() writes the DB row, the shadow metadata.json and the FTS row. For a
    # Tier B type that IS the standard index — the filesystem indexer is never
    # invoked, so ingestion cannot contend with it for the SQLite writer.
    #
    # notify=False during a backfill suppresses the per-entity data_op, and with
    # it the CREATE broadcast that would otherwise go to every connected client.
    await row.save(owner, notify=(mode is IngestMode.INCREMENTAL))

    # ── emit ──────────────────────────────────────────────────────────────
    # AFTER the save, so the id in the event is the one the row actually holds
    # (a new row's uuid4 is allocated by save, not before it).
    entity_id = str(row.id)
    if mode is IngestMode.INCREMENTAL:
        emit_item_tag(item, entity_id, status)

    return IngestOutcome(entity_id=entity_id, external_id=item.external_id, status=status)


async def ingest_items(
    items: Sequence[SourceItemSpec],
    *,
    owner: Optional[TypeId] = None,
    mode: IngestMode = IngestMode.INCREMENTAL,
) -> IngestReport:
    """Ingest a page in order.

    **Reads are batched, writes are not.** The whole page's existing rows load
    in one query (``DbSerializer.resolve_many``) — otherwise a steady-state poll
    where nothing changed would still cost one SELECT per item just to consult
    the digest gate.

    The writes stay a sequential loop, deliberately: small per-item writes never
    hold the SQLite writer across a whole page, and an item that raises leaves
    the successful prefix committed rather than rolling back work the cursor may
    already have advanced past.
    """
    report = IngestReport()
    known = await SourceItem.serializer().resolve_many(SourceItem, items)
    for item in items:
        report.outcomes.append(await ingest_item(item, owner=owner, mode=mode, known=known))
    return report
