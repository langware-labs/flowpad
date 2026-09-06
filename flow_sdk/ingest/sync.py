"""One poll cycle for one DataSource.

Reads cursors, calls the driver, hands what came back to the ingestor, advances
the cursor, rolls health up. It never touches provider APIs itself and never
looks inside a cursor's opaque ``state``.

**Three properties this file exists to guarantee:**

*Per-stream isolation.* Each cursor is fetched inside its own ``try``. A stream
that fails leaves its cursor **unadvanced** — re-delivery is a digest-gate no-op,
so re-fetching is free and losing a window is not — records its own health, and
the loop continues to its siblings. One dead feed must not stall a workspace.

*Records before cursor.* The cursor advances only after ``ingest_items`` has
returned. A crash costs a partial re-fetch; it can never open a gap.

*A budget, not a backoff.* Where a provider caps us, a run spends a fixed number
of requests on the streams that waited longest. The cadence is the retry rate —
there is deliberately no sleep, no backoff multiplier and no widened timeout
anywhere in this path.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.data_source_cursor import DataSourceCursor
from flow_sdk.ingest.driver import SegmentCursorView, channel_of_driver, get_driver
from flow_sdk.ingest.health import ERROR_DETAIL_MAX, SourceHealth, classify, worst_of
from flow_sdk.ingest.ingest_on_tag import emit_sync_tag
from flow_sdk.ingest.ingestor import ingest_items
from flow_sdk.ingest.models import IngestMode, IngestReport
from flow_sdk.ingest.reflect import get_reflector, reflect_refs

logger = logging.getLogger(__name__)

#: Streams fetched per run by default. A provider with a hard request ceiling
#: (Slack: one history call a minute) declares a smaller ``segment_budget`` on
#: its driver; the loop then round-robins by ``last_attempted_at`` so every
#: stream still converges, just over more ticks.
DEFAULT_SEGMENT_BUDGET = 5


async def sync_source(
    source: DataSource,
    *,
    now: Optional[datetime] = None,
    budget: int = DEFAULT_SEGMENT_BUDGET,
) -> IngestReport:
    """Run one cycle. Never raises: a failure is recorded as health, not thrown."""
    now = now or datetime.now(timezone.utc)
    combined = IngestReport()

    driver = get_driver(source.provider)
    if driver is None:
        await _fail_source(source, "unknown_provider", f"no driver registered for {source.provider!r}", now)
        return combined

    if not await source.capabilities_ready():
        await _fail_source(
            source,
            "capability_unavailable",
            f"requires {', '.join(source.required_capabilities)}",
            now,
        )
        return combined

    # `reflect` is a property of the SOURCE, knowable before any I/O, so it is
    # checked here rather than per segment after a fetch: a driver that places
    # files has no record destination, and with a mode that has no reflector
    # the files would be dropped while the cursor advanced past them — a source
    # that reads healthy and ingests nothing. Asked once, so a five-segment
    # folder source does not burn five fetches (and stamp five cursor rows) to
    # learn one config fact.
    if driver.origin_for is not None and get_reflector(source.reflect) is None:
        await _fail_source(
            source,
            "reflect_mode",
            f"reflect={source.reflect!r} cannot place files; pick a filesystem mode",
            now,
        )
        return combined

    # The driver owns the ontology kind; the row caches it, so a hand-typed
    # config can't drift from what the driver actually is.
    if driver.kind and source.kind != driver.kind:
        source.kind = driver.kind
    # The channel too — the badge and the thread key read it off the row, and a
    # row written before the field existed self-heals on its next poll. Second
    # invocation of ONE rule, not a fork: `DataSource.save` stamps the same
    # `channel_of_driver` answer at CREATE (empty-only), because the first
    # poll's projection races this post-fetch save.
    channel = channel_of_driver(driver, source)
    if channel and source.channel != channel:
        source.channel = channel

    emit_sync_tag(source.provider, source.id, "started")

    # Enumerating segments can fail for the same reasons a fetch can — a driver
    # that has to reach the provider to answer (any authored source does) can
    # raise here. This function promises never to raise, so the failure is
    # recorded as health like any other rather than reaching the poller's
    # "this is a bug" catch, where it left the source stuck on `never_synced`
    # with no error to show.
    try:
        segments = await driver.segments(source)
        cursors = await DataSourceCursor.for_source(source, segments)
    except Exception as exc:  # noqa: BLE001 — classified below, never re-raised
        health, code, detail = classify(exc)
        await _fail_source(source, code, detail, now, health=health)
        emit_sync_tag(source.provider, source.id, "completed", report=combined)
        return combined
    # The driver's ceiling is a limit, not a preference — `min`, so a caller
    # asking for more streams cannot spend a budget the provider does not have.
    stamps = {ref.key: ref.stamp for ref in segments if ref.stamp}
    due = _round_robin(cursors, min(budget, driver.segment_budget or budget), stamps)

    for cursor in due:
        stream = await _sync_stream(source, driver, cursor, now, stamp=stamps.get(cursor.segment_key, ""))
        combined.outcomes.extend(stream.outcomes)

    await _roll_up(source, cursors, now)
    emit_sync_tag(source.provider, source.id, "completed", report=combined)
    logger.info(
        "[ingest] %s/%s streams=%d %s",
        source.provider,
        source.name or source.account_key,
        len(due),
        combined.as_counts(),
    )
    return combined


async def _place(source: DataSource, result, view: SegmentCursorView) -> Optional[IngestReport]:
    """Put a fetch's payload where the SOURCE says it goes; the report, if any.

    A driver's payload lands EITHER in the graph as a record or on disk as an
    asset, never both. `ingest_items` stays the single chokepoint for
    SourceItem writes — reflection is a second destination beside it, not a
    branch inside it, so that invariant survives a source whose payload is a
    file.

    Which one is chosen by the SOURCE (`reflect`), not the driver: the same
    folder could reasonably be mirrored as records or as assets, and a driver
    that decided this would be deciding a policy question with only transport
    knowledge.
    """
    if result.unchanged:
        return None
    report = None
    if result.items:
        report = await ingest_items(
            result.items,
            mode=IngestMode.for_run(item_count=len(result.items)),
        )
    if result.refs or result.tombstones:
        # `sync_source` refused the run before enumerating segments if this
        # source cannot place files, so a reflector exists here.
        await reflect_refs(source, result.refs, result.tombstones, result.renames)
    return report


async def _sync_stream(
    source, driver, cursor: DataSourceCursor, now: datetime, *, stamp: str = ""
) -> IngestReport:
    report = IngestReport()
    cursor.last_attempted_at = now

    view = SegmentCursorView(
        segment_key=cursor.segment_key,
        state=dict(cursor.state or {}),
        window_start=source.window_floor(now).isoformat(),
        first_run=cursor.last_synced_at is None,
    )

    # One `try` around the fetch AND the two writes. The old one covered only
    # the fetch, so an `ingest_items` or `reflect_refs` exception escaped
    # `sync_source`'s "never raises" promise straight into the poller's
    # this-is-a-bug catch: no health recorded, no roll-up, the source stuck on
    # whatever it showed before. A write failure is classified like a fetch
    # failure — transient unless the driver said otherwise — and, because the
    # cursor is written only below, it leaves the position exactly where it was.
    try:
        result = await driver.fetch(source, view)
        report = await _place(source, result, view) or report
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
        and (cursor.state or {}) == (result.next_state or {})
        # COMPARE, don't test truthiness. A driver that reports an unchanged
        # high-water on an idle poll — `folder` returns its file count, `git`
        # returns the unmoved head — would otherwise fail this check forever and
        # rewrite its cursor row every tick. For `folder` that row carries the
        # whole directory manifest, so a large watched tree meant megabytes of
        # identical JSON through the writer lock once a minute. `gdrive` omits
        # `high_water` entirely to dodge this; comparing fixes it for all three.
        and cursor.high_water == result.high_water
        and (cursor.segment_stamp or "") == stamp
    )
    cursor.state = result.next_state or {}
    if result.high_water:
        cursor.high_water = result.high_water
    if stamp:
        cursor.segment_stamp = stamp
    cursor.last_synced_at = now
    cursor.mark_ok()

    # A stream that was already healthy and returned nothing new has no state
    # worth persisting — writing it anyway would put one SQLite writer-lock
    # acquisition per feed per tick on the floor forever, and would falsify the
    # "one request, zero writes" steady state the digest gate exists to give.
    # `last_attempted_at` stays in memory; the round-robin degrades gracefully
    # across a restart.
    if not (result.unchanged and was_clean):
        await cursor.save()
    return report

def _round_robin(
    cursors: list[DataSourceCursor], budget: int, stamps: Optional[dict[str, str]] = None
) -> list[DataSourceCursor]:
    """The ``budget`` streams that have waited longest.

    Never-attempted streams sort first, so a newly added feed is picked up on
    the next tick rather than starving behind healthy ones.

    A stream whose listing token (``stamps``) still equals the one recorded at
    its last good fetch has nothing new and is not a candidate — it neither
    costs a request nor holds a budget slot a moved stream needs. A stream
    whose token MOVED goes first of all, ahead of the never-attempted ones: a
    new source on a busy desk backfills dozens of old tickets a few per pass,
    and the one ticket a person is answering right now must not wait behind
    that backlog. And while anything has moved, the backlog only TRICKLES —
    one stream per pass beside the news — because a pass is one unit of
    latency: the next round cannot start until this one ends, and five old
    tickets' histories ingested and projected is what made a live reply take
    twenty seconds to land. Never-attempted streams keep the driver's listing
    order. A stream that last FAILED stays a candidate whatever its token
    says: the retry is the point.

    A ``config_error`` stream is not a candidate at all. It is parked until a
    person fixes it (``health.py``: that state stops polling for ITS scope), so
    spending budget on it would re-learn the same failure every tick — and on
    a provider with a hard request ceiling, starve a sibling that would work.
    """
    if budget <= 0:
        return []
    stamps = stamps or {}

    def _idle(c: DataSourceCursor) -> bool:
        token = stamps.get(c.segment_key, "")
        return bool(token) and c.health == SourceHealth.OK.value and (c.segment_stamp or "") == token

    def _moved(c: DataSourceCursor) -> bool:
        token = stamps.get(c.segment_key, "")
        return bool(token) and bool(c.segment_stamp) and c.segment_stamp != token

    candidates = [c for c in cursors if c.health != SourceHealth.CONFIG_ERROR.value and not _idle(c)]
    by_age = sorted(candidates, key=lambda c: (c.last_attempted_at is not None, c.last_attempted_at or datetime.min))
    moved = [c for c in by_age if _moved(c)]
    rest = [c for c in by_age if not _moved(c)]
    if not moved:
        return rest[:budget]
    return (moved + rest[:1])[:budget]


async def _roll_up(source: DataSource, cursors: list[DataSourceCursor], now: datetime) -> None:
    # A parked segment stays parked on its own row; it must not park the
    # SOURCE. `poll_refusal` refuses a `config_error` source outright, so rolling
    # one bad channel up here used to stop every healthy sibling from polling
    # — the opposite of the per-stream isolation this module promises. The
    # source is `config_error` only when there is nothing left that could run,
    # which `worst_of` already answers: fall back to the full list only when
    # every segment is parked (and to the empty list's NEVER_SYNCED when there
    # are none at all).
    live = [c.health for c in cursors if c.health != SourceHealth.CONFIG_ERROR.value]
    health = worst_of(live or [c.health for c in cursors])
    # The card still names the worst offender, preferring one at the rolled-up
    # health and falling back to a parked segment — otherwise the parked row is
    # invisible on a source that reads healthy.
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
    """Record a whole-source failure. Defaults to CONFIG_ERROR — the callers that
    predate the parameter all name a cause a person has to fix — but enumerating
    segments can fail for a transient reason, and parking a source over one
    network blip is the mistake `SourceError.for_status` exists to prevent.

    Stamps through the same helper as `_roll_up`, so the two cannot drift: the
    `now` the run was given (not a second clock read), and a bounded detail.
    The segment count is left alone — this path failed BEFORE enumerating, so
    it has nothing truer to say than the row already does."""
    _stamp_source(source, health, code, detail, now)
    emit_sync_tag(
        source.provider, source.id, "failed", error_code=code, error_detail=detail
    )
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
    """The source row's verdict fields, written in ONE place.

    Both endings of a run — the roll-up over segments and a whole-source
    failure — stamp the same five fields, and a comment saying "mirrors the
    other" is exactly the kind of pairing that drifts. `segment_count` is
    optional because only the roll-up has counted.
    """
    source.health = health.value
    source.error_code = code
    source.error_detail = detail[:ERROR_DETAIL_MAX] if detail else detail
    if segment_count is not None:
        # Free: this row is being written anyway, and it saves every list
        # surface from watching the cursor table live just to render a count.
        source.segment_count = segment_count
    source.schedule_next(now)
