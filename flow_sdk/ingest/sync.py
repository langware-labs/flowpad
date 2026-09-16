"""One poll cycle for one DataSource.

Reads cursors, asks the source type to traverse each due segment, hands what came back to the
ingestor or to reflection, advances the cursor, rolls health up. It never touches provider APIs
itself and never looks inside a cursor: ``DataSourceCursor.cursor`` is the source's opaque string,
``manifest`` is the traversal's own diff bookkeeping, and both are carried verbatim.

**Three properties this file exists to guarantee:**

*Per-stream isolation.* Each cursor is traversed inside its own ``try``. A stream that fails leaves
its cursor **unadvanced** — re-delivery is a digest-gate no-op, so re-fetching is free and losing a
window is not — records its own health, and the loop continues to its siblings. One dead feed must
not stall a workspace.

*Records before cursor.* The cursor advances only after ``ingest_items`` has returned. A crash costs
a partial re-fetch; it can never open a gap.

*A budget, not a backoff.* Where a provider caps us, a run spends a fixed number of requests on the
streams that waited longest. The cadence is the retry rate — there is deliberately no sleep, no
backoff multiplier and no widened timeout anywhere in this path.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.data_source_cursor import DataSourceCursor
from flow_sdk.ingest.driver_registry import resolve_driver_type
from flow_sdk.ingest.driver_types import DriverType, SegmentPass, SegmentPosition
from flow_sdk.ingest.health import ERROR_DETAIL_MAX, SourceHealth, classify, worst_of
from flow_sdk.ingest.ingest_on_tag import emit_sync_tag
from flow_sdk.ingest.ingestor import ingest_items
from flow_sdk.ingest.models import IngestMode, IngestReport
from flow_sdk.ingest.reflect import get_reflector, reflect_refs

logger = logging.getLogger(__name__)

#: Streams fetched per run by default. A provider with a hard request ceiling (Slack: one history
#: call a minute) declares a smaller ``segment_budget`` on its class; the loop then round-robins by
#: ``last_attempted_at`` so every stream still converges, just over more ticks.
DEFAULT_SEGMENT_BUDGET = 5
#: While any stream has NEWS (its listing token moved), one pass takes the news plus this many
#: never-attempted streams. A pass is serial, so a live message waits behind whatever backfill
#: precedes it; this bounds that wait.
BACKLOG_PER_PASS_WHILE_MOVING = 1


async def sync_source(
    source: DataSource,
    *,
    now: Optional[datetime] = None,
    budget: int = DEFAULT_SEGMENT_BUDGET,
) -> IngestReport:
    """Run one cycle. Never raises: a failure is recorded as health, not thrown."""
    now = now or datetime.now(timezone.utc)
    combined = IngestReport()

    stype = await resolve_driver_type(source.provider)
    if stype is None:
        await _fail_source(source, "unknown_provider", f"no source type registered for {source.provider!r}", now)
        return combined

    if not await source.capabilities_ready():
        await _fail_source(source, "capability_unavailable", f"requires {', '.join(source.required_capabilities)}", now)
        return combined

    # `reflect` is a property of the SOURCE, knowable before any I/O: a reflecting source has no
    # record destination, and with a mode that has no reflector its files would be dropped while
    # the cursor advanced past them. Asked once, not per segment.
    if stype.reflects and get_reflector(source.reflect) is None:
        await _fail_source(source, "reflect_mode", f"reflect={source.reflect!r} cannot place files; pick a filesystem mode", now)
        return combined

    # The type owns the ontology kind and the channel; the row caches both so the badge and the
    # thread key read them, and a row written before a field existed self-heals on its next poll.
    if stype.kind and source.kind != stype.kind:
        source.kind = stype.kind
    channel = stype.channel_for(source) or stype.provider
    if channel and source.channel != channel:
        source.channel = channel

    emit_sync_tag(source.provider, source.id, "started")

    # Enumerating segments can fail for the same reasons a traversal can, and this function
    # promises never to raise, so the failure is recorded as health like any other.
    try:
        segments = await stype.segments(source)
        cursors = await DataSourceCursor.for_source(source, segments)
    except Exception as exc:  # noqa: BLE001 — classified below, never re-raised
        health, code, detail = classify(exc)
        await _fail_source(source, code, detail, now, health=health)
        emit_sync_tag(source.provider, source.id, "completed", report=combined)
        return combined
    # The class's ceiling is a limit, not a preference: a caller cannot spend a budget the
    # provider does not have.
    stamps = {ref.key: ref.stamp for ref in segments if ref.stamp}
    due = _round_robin(cursors, min(budget, stype.segment_budget or budget), stamps)

    for cursor in due:
        stream = await _sync_stream(source, stype, cursor, now, stamp=stamps.get(cursor.segment_key, ""))
        combined.outcomes.extend(stream.outcomes)

    await _roll_up(source, cursors, now)
    emit_sync_tag(source.provider, source.id, "completed", report=combined)
    logger.info("[ingest] %s/%s streams=%d %s", source.provider, source.name or source.account_key, len(due), combined.as_counts())
    return combined


async def _place(source: DataSource, found: SegmentPass) -> Optional[IngestReport]:
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
        # `sync_source` refused the run before enumerating segments if this source cannot place
        # files, so a reflector exists here.
        await reflect_refs(source, found.refs, found.tombstones, found.renames)
    return report


def _position_of(source: DataSource, cursor: DataSourceCursor, now: datetime) -> SegmentPosition:
    """Where the segment's last traversal left off. A row an older build wrote carries its position
    in ``state`` instead; the source type lifts it once, and a good pass clears it."""
    lifted = not cursor.cursor and not cursor.manifest
    return SegmentPosition(
        segment_key=cursor.segment_key,
        cursor=cursor.cursor,
        manifest=dict(cursor.manifest or {}),
        legacy_state=dict(cursor.state or {}) if lifted else {},
        window_start=source.window_floor(now).isoformat(),
    )


async def _sync_stream(source, stype: DriverType, cursor: DataSourceCursor, now: datetime, *, stamp: str = "") -> IngestReport:
    report = IngestReport()
    cursor.last_attempted_at = now

    # One `try` around the traversal AND the two writes: a write failure is classified like a
    # fetch failure, and because the cursor is written only below, it leaves the position exactly
    # where it was.
    try:
        found = await stype.traverse(source, _position_of(source, cursor, now))
        report = await _place(source, found) or report
    except Exception as exc:  # noqa: BLE001 — classified, never re-raised
        health, code, detail = classify(exc)
        cursor.health = health.value
        cursor.error_code = code
        cursor.error_detail = detail[:ERROR_DETAIL_MAX]
        cursor.consecutive_failures = (cursor.consecutive_failures or 0) + 1
        # Cursor position deliberately NOT advanced.
        await cursor.save()
        logger.warning("[ingest] %s stream %s failed: %s", source.provider, cursor.segment_key, code)
        return report

    # ── records are committed; only now does the cursor move ──
    was_clean = (
        cursor.health == SourceHealth.OK.value
        and not cursor.consecutive_failures
        and not cursor.state
        and cursor.cursor == found.cursor
        and (cursor.manifest or {}) == (found.manifest or {})
        # COMPARE, don't test truthiness: an idle folder reports its unchanged file count, git its
        # unmoved head — a truthiness check would rewrite the cursor row, manifest and all, every tick.
        and cursor.high_water == found.high_water
        and (cursor.segment_stamp or "") == stamp
    )
    cursor.cursor = found.cursor
    cursor.manifest = found.manifest or {}
    cursor.state = {}
    if found.high_water:
        cursor.high_water = found.high_water
    if stamp:
        cursor.segment_stamp = stamp
    cursor.last_synced_at = now
    cursor.mark_ok()

    # A stream that was already healthy and returned nothing new has no position worth persisting —
    # writing it anyway would put one SQLite writer-lock acquisition per feed per tick on the floor
    # forever. `last_attempted_at` stays in memory; the round-robin degrades gracefully on restart.
    if not (found.unchanged and was_clean):
        await cursor.save()
    return report


def _round_robin(cursors: list[DataSourceCursor], budget: int, stamps: dict[str, str]) -> list[DataSourceCursor]:
    """The ``budget`` streams that have waited longest.

    Never-attempted streams sort first, so a newly added feed is picked up on the next tick rather
    than starving behind healthy ones. A stream whose listing token (``stamps``) still equals the one
    recorded at its last good fetch has nothing new and is not a candidate. A stream whose token
    MOVED goes first of all, ahead of the never-attempted ones, and the backlog only trickles while
    the news flows (``BACKLOG_PER_PASS_WHILE_MOVING``). A stream that last FAILED stays a candidate
    whatever its token says. A ``config_error`` stream is not a candidate at all: it is parked until
    a person fixes it.
    """
    if budget <= 0:
        return []

    def _idle(c: DataSourceCursor) -> bool:
        token = stamps.get(c.segment_key, "")
        return bool(token) and c.health == SourceHealth.OK.value and (c.segment_stamp or "") == token

    def _moved(c: DataSourceCursor) -> bool:
        token = stamps.get(c.segment_key, "")
        return bool(token) and bool(c.segment_stamp) and c.segment_stamp != token

    candidates = [c for c in cursors if c.health != SourceHealth.CONFIG_ERROR.value and not _idle(c)]
    by_age = sorted(candidates, key=lambda c: (c.last_attempted_at is not None, c.last_attempted_at or datetime.min))
    moved: list[DataSourceCursor] = []
    rest: list[DataSourceCursor] = []
    for cursor in by_age:
        (moved if _moved(cursor) else rest).append(cursor)
    if not moved:
        return rest[:budget]
    return (moved + rest[:BACKLOG_PER_PASS_WHILE_MOVING])[:budget]


async def _roll_up(source: DataSource, cursors: list[DataSourceCursor], now: datetime) -> None:
    # A parked segment stays parked on its own row; it must not park the SOURCE. The source is
    # `config_error` only when nothing is left that could run — `worst_of` over the live segments,
    # falling back to the full list only when every segment is parked.
    live = [c.health for c in cursors if c.health != SourceHealth.CONFIG_ERROR.value]
    health = worst_of(live or [c.health for c in cursors])
    # The card still names the worst offender, preferring one at the rolled-up health and falling
    # back to a parked segment — otherwise the parked row is invisible on a source that reads healthy.
    offender = next(
        (c for c in cursors if c.health == health.value and c.error_code), None
    ) or next(
        (c for c in cursors if c.health == SourceHealth.CONFIG_ERROR.value and c.error_code), None
    )
    if health is SourceHealth.OK:
        source.last_synced_at = now
    _stamp_source(
        source,
        health,
        offender.error_code if offender else None,
        offender.error_detail if offender else None,
        now,
        segment_count=len(cursors),
    )
    await source.save()


async def _fail_source(
    source: DataSource,
    code: str,
    detail: str,
    now: datetime,
    *,
    health: SourceHealth = SourceHealth.CONFIG_ERROR,
) -> None:
    """Record a whole-source failure. Defaults to CONFIG_ERROR — the callers that predate the
    parameter all name a cause a person has to fix — but enumerating segments can fail for a
    transient reason, and parking a source over one network blip is the mistake to prevent."""
    _stamp_source(source, health, code, detail, now)
    emit_sync_tag(source.provider, source.id, "failed", error_code=code, error_detail=detail)
    await source.save()


def _stamp_source(
    source: DataSource,
    health: SourceHealth,
    code: Optional[str],
    detail: Optional[str],
    now: datetime,
    *,
    segment_count: Optional[int] = None,
) -> None:
    """The source row's verdict fields, written in ONE place — both endings of a run stamp the
    same five fields. `segment_count` is optional because only the roll-up has counted."""
    source.health = health.value
    source.error_code = code
    source.error_detail = detail[:ERROR_DETAIL_MAX] if detail else detail
    if segment_count is not None:
        source.segment_count = segment_count
    source.schedule_next(now)
