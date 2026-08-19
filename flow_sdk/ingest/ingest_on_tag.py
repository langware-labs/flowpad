"""Ingestion-family bus adapter — the deletable bridge to the FlowEvent bus.

Follows the ``<family>_on_tag.py`` convention (see ``flow_sdk/db/entity_on_tag.py``):
best-effort, lazy bus import, and never able to fail the write that triggered it.

Tag shape is ``ingest.<provider>.<layer>.<verb>``, a fixed four segments so the
subscription globs behave. Under the bus grammar (``*`` matches exactly one
segment, a TRAILING ``*`` matches any suffix):

    ingest.*                     every ingestion event
    ingest.rss.*                 one provider
    ingest.*.item.created        every provider's new items
    ingest.*.sync.completed      the low-volume operational lane
    ingest                       matches NOTHING — equal length is required

``data`` carries identity and a pointer, never the record body. The entity is
the truth; the bus persists nothing, so a subscriber must be able to recover
from the row after a restart.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.ingest.models import IngestItem, IngestReport

logger = logging.getLogger(__name__)

def emit_item_tag(item: "IngestItem", entity_id: str, status: str) -> None:
    """Announce one ingested record. The verb IS the status.

    ``unchanged`` is silent — a no-op poll costing nothing downstream is the
    whole point of the digest gate.
    """
    if status == "unchanged":
        return
    try:
        from flow_sdk.tags import emit_tag, target_of

        emit_tag(
            f"ingest.{item.provider}.item.{status}",
            target_of("source_item", entity_id),
            {
                "source_id": item.source_id,
                "provider": item.provider,
                "kind": item.kind,
                "segment_key": item.segment_key,
                "external_id": item.external_id,
                "occurred_at": item.occurred_at,
                "entity_id": entity_id,
            },
            ctx={"scope": [target_of("data_source", item.source_id)]},
        )
    except Exception:
        logger.debug("ingest.on_tag: item emission failed", exc_info=True)


def emit_sync_tag(
    provider: str,
    source_id: str,
    verb: str,
    *,
    segment_key: Optional[str] = None,
    report: Optional["IngestReport"] = None,
    error_code: Optional[str] = None,
    error_detail: Optional[str] = None,
) -> None:
    """Announce a poll-cycle boundary (``started`` | ``completed`` | ``failed``).

    This is the lane a flow should normally subscribe to: one event per cycle
    rather than one per record, carrying ``changed_ids`` so the flow can fan out
    itself. Subscribing to ``ingest.*.item.created`` instead is opting into the
    per-item lane and its 30/min ceiling.
    """
    try:
        from flow_sdk.tags import emit_tag, target_of

        data: dict = {"provider": provider, "source_id": source_id}
        if segment_key is not None:
            data["segment_key"] = segment_key
        if report is not None:
            data.update(report.as_counts())
            data["changed_ids"] = report.changed_ids
        if error_code:
            data["error_code"] = error_code
        if error_detail:
            data["error_detail"] = error_detail

        emit_tag(
            f"ingest.{provider}.sync.{verb}",
            target_of("data_source", source_id),
            data,
        )
    except Exception:
        logger.debug("ingest.on_tag: sync emission failed", exc_info=True)
