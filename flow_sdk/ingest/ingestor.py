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
indexed read (the natural key, via ``ix_entities_source_item_natural_key``) and
nothing else — no save, no metadata.json write, no FTS write, no WS broadcast,
no event. Feeds re-serve their whole window on every
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
    known: Optional[dict[tuple[str, str, str], SourceItem]] = None,
) -> IngestOutcome:
    """``known`` is a pre-loaded ``{(source, stream, external_id): row}`` map
    from ``ingest_items``; without it this falls back to a single lookup.

    **Identity is the natural key, not the id.** The row is resolved by
    ``(data_source, stream, external id)``; a genuinely new record gets an
    ordinary ``uuid4``. That is what makes a re-poll idempotent — and it works
    on rows written before ids were v4, because nothing here re-derives an id.
    """
    digest = content_digest(item)
    key = (item.source_id, item.stream_key, item.external_id)

    if known is not None:
        existing = known.get(key)
    else:
        existing = await SourceItem.find_existing(
            item.source_id, item.stream_key, item.external_id
        )

    # ── the gate ──────────────────────────────────────────────────────────
    if existing is not None and existing.content_digest == digest:
        return IngestOutcome(
            entity_id=str(existing.id), external_id=item.external_id, status="unchanged"
        )

    row = existing or SourceItem()

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
    # AFTER the save, so the id in the event is the one the row actually holds
    # (a new row's uuid4 is allocated by save, not before it).
    entity_id = str(row.id)
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

    **Reads are batched, writes are not.** The whole page's existing rows load
    in one query — otherwise a steady-state poll where nothing changed would
    still cost one SELECT per item just to consult the digest gate.

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


async def _load_existing(
    items: Sequence[IngestItem],
) -> dict[tuple[str, str, str], SourceItem]:
    """The page's existing rows, keyed by the full natural key.

    One query per ``(source, stream)`` group, which is ONE query for every real
    page — a poll fetches a single stream of a single source (``sync.py``), and
    only the write route can hand in a mixed batch.

    All three key components are in the query AND in the map key, because both
    halves matter: an external id is only unique within a stream (a Slack ``ts``
    repeats across channels), so a partial key would hand the digest gate the
    wrong row — re-saving an unchanged record and clobbering its sibling. The
    lookup rides ``ix_entities_source_item_natural_key``; without that index
    this is a full scan of the type on every poll.
    """
    if not items:
        return {}
    groups: dict[tuple[str, str], set[str]] = {}
    for item in items:
        groups.setdefault((item.source_id, item.stream_key), set()).add(item.external_id)

    known: dict[tuple[str, str, str], SourceItem] = {}
    for (source_id, stream_key), external_ids in groups.items():
        rows = await SourceItem.get_all(
            QueryFilter(match=ExpressionNode(op=QueryOp.AND, operands=[
                ExpressionNode(op=QueryOp.EQ, operands=["data_source_id", source_id]),
                ExpressionNode(op=QueryOp.EQ, operands=["stream_key", stream_key]),
                ExpressionNode(op=QueryOp.IN, operands=["external_id", list(external_ids)]),
            ]))
        )
        for row in rows:
            known[(source_id, stream_key, str(row.external_id))] = row
    return known
