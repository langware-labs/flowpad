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
primary-key read and nothing else — no save, no metadata.json write, no FTS
write, no WS broadcast, no event. Feeds re-serve their whole window on every
poll, so without this gate a 5-minute poller rewrites and re-announces the same
records forever.
"""
from __future__ import annotations

import logging
from typing import Optional, Sequence

from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.ingest.digest import content_digest
from flow_sdk.ingest.ingest_on_tag import emit_item_tag
from flow_sdk.ingest.models import IngestItem, IngestMode, IngestOutcome, IngestReport

logger = logging.getLogger(__name__)

#: Snapshot fields, as an explicit ``entity attr -> item attr`` map.
#:
#: Explicit rather than a name-matching loop: the two shapes deliberately differ
#: (``source_id`` on the wire, ``data_source_id`` on the row; ``title`` on the
#: wire, ``name`` on the row), and a mismatch should be visible here rather than
#: raising AttributeError on the first real payload.
#:
#: Everything on SourceItem that is NOT listed here is local state and must
#: survive re-delivery — today ``read`` and ``starred``.
_SNAPSHOT_FIELDS: dict[str, str] = {
    "name": "title",
    "kind": "kind",
    "provider": "provider",
    "data_source_id": "source_id",
    "stream_key": "stream_key",
    "stream_label": "stream_label",
    "external_id": "external_id",
    "thread_key": "thread_key",
    "reply_to_external_id": "reply_to_external_id",
    "permalink": "permalink",
    "occurred_at": "occurred_at",
    "author_external_id": "author_external_id",
    "author_display": "author_display",
    "body": "body",
    "raw": "raw",
}


async def ingest_item(
    item: IngestItem,
    *,
    owner: Optional[TypeId] = None,
    mode: IngestMode = IngestMode.INCREMENTAL,
    known: Optional[dict[str, SourceItem]] = None,
) -> IngestOutcome:
    """``known`` is a pre-loaded ``{entity_id: row}`` map from ``ingest_items``;
    without it this falls back to a single lookup."""
    entity_id = SourceItem.allocate_deterministic_id(
        item.source_id, item.stream_key, item.external_id
    )
    digest = content_digest(item)

    if known is not None:
        existing = known.get(entity_id)
    else:
        existing = await SourceItem.get_one({"id": entity_id})

    # ── the gate ──────────────────────────────────────────────────────────
    if existing is not None and existing.content_digest == digest:
        return IngestOutcome(entity_id=entity_id, external_id=item.external_id, status="unchanged")

    row = existing or SourceItem(id=entity_id)

    for row_attr, item_attr in _SNAPSHOT_FIELDS.items():
        setattr(row, row_attr, getattr(item, item_attr))
    row.content_digest = digest

    status = "created" if existing is None else "updated"

    # ── record + index ────────────────────────────────────────────────────
    # save() writes the DB row, the shadow metadata.json and the FTS row. For a
    # Tier B type that IS the standard index — the filesystem indexer is never
    # invoked, so ingestion cannot contend with it for the SQLite writer.
    #
    # notify=False during a backfill suppresses the per-entity data_op, and with
    # it the CREATE broadcast that would otherwise go to every connected client.
    await row.save(owner, notify=(mode is IngestMode.INCREMENTAL))

    # ── emit ──────────────────────────────────────────────────────────────
    if mode is IngestMode.INCREMENTAL:
        emit_item_tag(item, entity_id, status)

    return IngestOutcome(entity_id=entity_id, external_id=item.external_id, status=status)


async def ingest_items(
    items: Sequence[IngestItem],
    *,
    owner: Optional[TypeId] = None,
    mode: IngestMode = IngestMode.INCREMENTAL,
) -> IngestReport:
    """Ingest a page in order.

    **Reads are batched, writes are not.** The ids are deterministic, so the
    whole page's existing rows load in one indexed ``IN`` query — otherwise a
    steady-state poll where nothing changed would still cost one SELECT per
    item just to consult the digest gate.

    The writes stay a sequential loop, deliberately: small per-item writes never
    hold the SQLite writer across a whole page, and an item that raises leaves
    the successful prefix committed rather than rolling back work the cursor may
    already have advanced past.
    """
    report = IngestReport()
    known = await _load_existing(items)
    for item in items:
        report.outcomes.append(await ingest_item(item, owner=owner, mode=mode, known=known))
    return report


async def _load_existing(items: Sequence[IngestItem]) -> dict[str, SourceItem]:
    """One query for the page's existing rows, keyed by entity id."""
    ids = [
        SourceItem.allocate_deterministic_id(i.source_id, i.stream_key, i.external_id)
        for i in items
    ]
    if not ids:
        return {}
    rows = await SourceItem.get_all(
        QueryFilter(match=ExpressionNode(op=QueryOp.IN, operands=["id", ids]))
    )
    return {str(row.id): row for row in rows}
