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

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.driver_runtime import Pass, position_of
from flow_sdk.ingest.health import MIRROR_CODES, SourceHealth, classify, stamp_error
from flow_sdk.ingest.ingest_on_tag import emit_sync_tag
from flow_sdk.ingest.ingestor import ingest_items
from flow_sdk.ingest.models import IngestMode, IngestReport
from flow_sdk.ingest.reflect import get_reflector, keep_out_of_git, reflect_refs
from flow_sdk.ingest.write_back import write_back
from flow_sdk.sources.errors import SourceUnavailable
from flow_sdk.stream_inbox._locks import keyed_loop_lock, new_registry

logger = logging.getLogger(__name__)


#: One cycle per source at a time, whoever asks: the poller's tick claims a slot (and skips a busy source),
#: but "Sync now" and a reply's expect call this directly — two cycles of one source race each other's
#: cursor, cache index and write-back (found live: every file of a new row written to Drive twice).
#: Weak-valued (``stream_inbox/_locks``): a source's lock lives only while a cycle holds or awaits it.
_CYCLES = new_registry()


async def sync_source(source: DataSource, *, now: Optional[datetime] = None) -> IngestReport:
    """Run one cycle. Never raises: a failure is recorded as health, not thrown. A second call for the same
    source waits for the running one, then runs against what it left."""
    async with keyed_loop_lock(_CYCLES, str(source.id)):
        return await _sync_source(source, now=now)


async def _sync_source(source: DataSource, *, now: Optional[datetime] = None) -> IngestReport:
    now = now or datetime.now(timezone.utc)
    report = IngestReport()

    stype = await DataDriver.find(source.provider)
    if stype is None:
        await _fail_source(source, "unknown_provider", f"no source type registered for {source.provider!r}", now)
        return report

    if not await source.capabilities_ready():
        await _fail_source(source, "capability_unavailable", f"requires {', '.join(source.required_capabilities)}", now)
        return report

    # `reflect` is a property of the SOURCE, knowable before any I/O: a reflecting source has no
    # record destination, and with a mode that has no reflector its files would be dropped while
    # the cursor advanced past them.
    if stype.is_object and get_reflector(source.reflect) is None:
        await _fail_source(source, "reflect_mode", f"reflect={source.reflect!r} cannot place files; pick a filesystem mode", now)
        return report
    # The local copy is kept out of git BEFORE anything lands in it: a target git tracks refuses the
    # run here, so the cursor never moves past files that were not placed.
    if stype.is_object and (refused := await asyncio.to_thread(keep_out_of_git, source)):
        await _fail_source(source, *refused, now)
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
        if stype.push_only and stype.has_setup:
            # Nothing to fetch, so the poll proves the delivery path instead: the same verify as the Verify button.
            # Not set up any more moves the source to setup (the scheduler polls active sources only); a provider
            # that cannot answer raises, a failed poll like any other.
            verdict = await source.verify()
            if verdict.get("transient"):
                raise SourceUnavailable(str(verdict.get("detail") or ""))
            if not verdict.get("ready"):
                # The provider answered (no): an earlier "did not answer" is no longer true. The row says setup.
                if source.health == SourceHealth.TRANSIENT_ERROR.value:
                    source.health, source.error_code, source.error_detail = SourceHealth.OK.value, None, None
                    source.consecutive_failures = 0
                    await source.save_runtime()
                emit_sync_tag(source.provider, source.id, "completed", report=report)
                return report
        found = await stype.traverse(source, position_of(source, now))
        placed = await _place(source, found)
        # The other direction, same pass: local edits of a `copy` source go back (generic; None when the
        # source does not write back). A held or refused file is a person's to resolve, said on the card.
        written = await write_back(source)
    except Exception as exc:  # noqa: BLE001 — classified, recorded, never re-raised
        health, code, detail = classify(exc)
        source.consecutive_failures = (source.consecutive_failures or 0) + 1
        await _fail_source(source, code, detail, now, health=health)
        emit_sync_tag(source.provider, source.id, "completed", report=report)
        return report
    if placed is not None:
        report.outcomes.extend(placed.outcomes)
        report.removed += placed.removed

    # Idle and clean: nothing arrived, the position did not move and the row already reads healthy,
    # so the steady state is one request and zero writes per tick (the poller stamped the next poll).
    idle = found.unchanged and found.cursor == source.cursor and (found.manifest or {}) == (source.manifest or {})
    clean = (source.health == SourceHealth.OK.value and (not source.error_code or source.error_code in MIRROR_CODES)
             and not source.consecutive_failures)
    # Waiting on a person, not broken: the source keeps polling and its card says what to resolve.
    waiting = ("write_back_held", written.sentence()) if written is not None and written.needs_a_person else (None, None)
    if idle and clean and waiting[0] is None:
        source.schedule_next(now)
        emit_sync_tag(source.provider, source.id, "completed", report=report)
        return report

    source.cursor = found.cursor
    source.manifest = found.manifest or {}
    if found.high_water:
        source.high_water = found.high_water
    source.consecutive_failures = 0
    source.last_synced_at = now
    _stamp_source(source, SourceHealth.OK, *waiting, now)
    await source.save_runtime()
    emit_sync_tag(source.provider, source.id, "completed", report=report)
    logger.info("[ingest] %s/%s %s", source.provider, source.name or source.account_key, report.as_counts())
    return report


async def read_older(source: DataSource, before: datetime, page_size: int) -> tuple[int, bool]:
    """One page of ``source``'s messages older than ``before`` into the store — ``(how many arrived, exhausted)``.

    The on-demand step back a paged list takes past its oldest held row; never a backfill. The row's cursor,
    manifest and window are untouched (the forward sync owns them), and nothing is dropped. A source that
    cannot read backwards answers ``(0, True)``: what is held is all there is."""
    stype = await DataDriver.find(source.provider)
    if stype is None or not stype.cls.pages_backward:
        return 0, True
    found = await stype.read_before(source, before, page_size)
    # Only the placing shares the forward cycle's lock: the read touches no position, so a slow provider
    # never holds up that source's sync.
    async with keyed_loop_lock(_CYCLES, str(source.id)):
        await _place(source, found)
    return len(found.items), len(found.items) < page_size


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
    if found.listed is not None:
        removed = await _drop_gone(source, found.listed)
        if removed:
            report = report or IngestReport()
            report.removed = removed
    if found.reactions:
        # After the records: a reaction in the same page as its message lands on that message.
        from flow_sdk.stream_inbox.reactions import apply_reactions  # noqa: PLC0415

        await apply_reactions(source, found.reactions)
    return report


async def _drop_gone(source: DataSource, listed: frozenset) -> int:
    """Remove this source's stored records that the outside system no longer has -- ``listed`` is its
    whole collection, proven by the pass (``Pass.listed``). Returns how many went.

    An EMPTY listing is as much proof as any other: the pass read the collection from start to end
    without an error (an outage raises and is classified by ``sync_source``; it never reaches here),
    so a collection that answers "no rows" has none, and the last record goes like the others. A
    source that cannot tell "no rows" from "no answer" must raise, not list nothing."""
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

    stored = await SourceItem.get_all({"data_source_id": str(source.id)}) or []
    gone = [item for item in stored if item.external_id not in listed]
    if not gone:
        return 0
    for item in gone:
        await item.delete()
    logger.info("[ingest] %s/%s: %d record(s) gone in the outside system, removed",
                source.provider, source.name or source.account_key, len(gone))
    return len(gone)


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
    stamp_error(source, code, detail)
    source.schedule_next(now)


__all__ = ["sync_source"]
