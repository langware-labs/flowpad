"""One poll cycle for one DataSource.

A data source reads one stream. This asks the driver to traverse it from the row's position, hands
what came back to the ingestor or to reflection, then advances the position and stamps health. It
never touches provider APIs itself and never looks inside a cursor: ``DataSource.cursor`` is the
source's opaque string, ``manifest`` is the traversal's own diff bookkeeping, and both are carried
verbatim.

**Two properties this file exists to guarantee:**

*Records before cursor.* The position advances only after ``ingest_items`` (or reflection) has
returned. A crash costs a partial re-fetch — a digest-gate no-op — and can never open a gap.

*A failure is health, not an exception.* A failed pass leaves the position unadvanced and records
why on the row. The cadence is the retry rate — there is deliberately no sleep, no backoff
multiplier and no widened timeout anywhere in this path.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.driver_runtime import Pass, position_of
from flow_sdk.ingest.health import ERROR_DETAIL_MAX, SourceHealth, classify
from flow_sdk.ingest.ingest_on_tag import emit_sync_tag
from flow_sdk.ingest.ingestor import ingest_items
from flow_sdk.ingest.models import IngestMode, IngestReport
from flow_sdk.ingest.reflect import get_reflector, reflect_refs

logger = logging.getLogger(__name__)


async def sync_source(source: DataSource, *, now: Optional[datetime] = None) -> IngestReport:
    """Run one cycle. Never raises: a failure is recorded as health, not thrown."""
    now = now or datetime.now(timezone.utc)
    report = IngestReport()

    stype = await DataDriver.get(source.provider)
    if stype is None:
        await _fail_source(source, "unknown_provider", f"no source type registered for {source.provider!r}", now)
        return report

    if not await source.capabilities_ready():
        await _fail_source(source, "capability_unavailable", f"requires {', '.join(source.required_capabilities)}", now)
        return report

    # `reflect` is a property of the SOURCE, knowable before any I/O: a reflecting source has no
    # record destination, and with a mode that has no reflector its files would be dropped while
    # the cursor advanced past them.
    if stype.reflects and get_reflector(source.reflect) is None:
        await _fail_source(source, "reflect_mode", f"reflect={source.reflect!r} cannot place files; pick a filesystem mode", now)
        return report

    # The type owns the ontology kind and the channel; the row caches both so the badge and the
    # thread key read them, and a row written before a field existed self-heals on its next poll.
    if stype.kind and source.kind != stype.kind:
        source.kind = stype.kind
    channel = stype.channel_for(source) or stype.provider
    if channel and source.channel != channel:
        source.channel = channel

    emit_sync_tag(source.provider, source.id, "started")
    source.last_attempted_at = now
    try:
        # Who it reads as first: the records this pass lands must tell our own posts from a stranger's.
        await stype.identify(source)
        found = await stype.traverse(source, position_of(source, now))
        placed = await _place(source, found)
    except Exception as exc:  # noqa: BLE001 — classified, recorded, never re-raised
        health, code, detail = classify(exc)
        source.consecutive_failures = (source.consecutive_failures or 0) + 1
        await _fail_source(source, code, detail, now, health=health)
        emit_sync_tag(source.provider, source.id, "completed", report=report)
        return report
    if placed is not None:
        report.outcomes.extend(placed.outcomes)

    # Idle and clean: nothing arrived, the position did not move and the row already reads healthy,
    # so the steady state is one request and zero writes per tick (the poller stamped the next poll).
    idle = found.unchanged and found.cursor == source.cursor and (found.manifest or {}) == (source.manifest or {})
    clean = source.health == SourceHealth.OK.value and not source.error_code and not source.consecutive_failures
    if idle and clean:
        source.schedule_next(now)
        emit_sync_tag(source.provider, source.id, "completed", report=report)
        return report

    source.cursor = found.cursor
    source.manifest = found.manifest or {}
    if found.high_water:
        source.high_water = found.high_water
    source.consecutive_failures = 0
    source.last_synced_at = now
    _stamp_source(source, SourceHealth.OK, None, None, now)
    await source.save_runtime()
    emit_sync_tag(source.provider, source.id, "completed", report=report)
    logger.info("[ingest] %s/%s %s", source.provider, source.name or source.account_key, report.as_counts())
    return report


async def _place(source: DataSource, found: Pass) -> Optional[IngestReport]:
    """Put a traversal's payload where the SOURCE says it goes; the report, if any.

    A payload lands EITHER in the graph as a record or on disk as an asset, never both.
    `ingest_items` stays the single chokepoint for SourceItem writes — reflection is a second
    destination beside it, not a branch inside it. Which one is the SOURCE's choice (`reflect`).
    """
    if found.unchanged:
        return None
    report = None
    if found.items:
        report = await ingest_items(found.items, mode=IngestMode.for_run(item_count=len(found.items)))
    if found.refs or found.tombstones:
        # `sync_source` refused the run before traversing if this source cannot place files, so a
        # reflector exists here.
        await reflect_refs(source, found.refs, found.tombstones, found.renames)
    return report


async def _fail_source(
    source: DataSource,
    code: str,
    detail: str,
    now: datetime,
    *,
    health: SourceHealth = SourceHealth.CONFIG_ERROR,
) -> None:
    """Record a failure. Defaults to CONFIG_ERROR — the callers that name a cause a person has to fix —
    while a traversal's own failure passes its classified health, so one network blip never parks."""
    _stamp_source(source, health, code, detail, now)
    emit_sync_tag(source.provider, source.id, "failed", error_code=code, error_detail=detail)
    await source.save_runtime()


def _stamp_source(source: DataSource, health: SourceHealth, code: Optional[str], detail: Optional[str], now: datetime) -> None:
    """The source row's verdict fields, written in ONE place — both endings of a run stamp them."""
    source.health = health.value
    source.error_code = code
    source.error_detail = detail[:ERROR_DETAIL_MAX] if detail else detail
    source.schedule_next(now)


__all__ = ["sync_source"]
