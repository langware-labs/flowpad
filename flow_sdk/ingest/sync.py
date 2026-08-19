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

import inspect
import logging
from datetime import datetime, timezone
from typing import Optional

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.data_source_cursor import DataSourceCursor
from flow_sdk.ingest.driver import SegmentCursorView, channel_of_driver, get_driver
from flow_sdk.ingest.health import SourceHealth, classify, worst_of
from flow_sdk.ingest.ingest_on_tag import emit_sync_tag
from flow_sdk.ingest.ingestor import ingest_items
from flow_sdk.ingest.models import IngestMode, IngestReport
from flow_sdk.ingest.reflect import reflect_refs

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
        await _fail_source(source, "unknown_provider", f"no driver registered for {source.provider!r}")
        return combined

    if not await source.capabilities_ready():
        await _fail_source(
            source,
            "capability_unavailable",
            f"requires {', '.join(source.required_capabilities)}",
        )
        return combined

    # The driver owns the ontology kind; the row caches it, so a hand-typed
    # config can't drift from what the driver actually is.
    if driver.kind and source.kind != driver.kind:
        source.kind = driver.kind
    # The channel too — the badge and the thread key read it off the row, and a
    # row written before the field existed self-heals on its next poll.
    channel = channel_of_driver(driver, source)
    if channel and source.channel != channel:
        source.channel = channel

    emit_sync_tag(source.provider, source.id, "started")

    cursors = await _cursors_for(source, driver)
    # The driver's ceiling is a limit, not a preference — `min`, so a caller
    # asking for more streams cannot spend a budget the provider does not have.
    due = _round_robin(cursors, min(budget, getattr(driver, "segment_budget", budget)))

    for cursor in due:
        combined.outcomes.extend((await _sync_stream(source, driver, cursor, now)).outcomes)

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


async def _sync_stream(source, driver, cursor: DataSourceCursor, now: datetime) -> IngestReport:
    report = IngestReport()
    cursor.last_attempted_at = now

    view = SegmentCursorView(
        segment_key=cursor.segment_key,
        state=dict(cursor.state or {}),
        window_start=source.window_floor(now).isoformat(),
        first_run=cursor.last_synced_at is None,
    )

    try:
        result = await driver.fetch(source, view)
    except Exception as exc:  # noqa: BLE001 — classified, never re-raised
        health, code, detail = classify(exc)
        cursor.health = health.value
        cursor.error_code = code
        cursor.error_detail = detail[:500]
        cursor.consecutive_failures = (cursor.consecutive_failures or 0) + 1
        # Cursor position deliberately NOT advanced.
        await cursor.save()
        logger.warning("[ingest] %s stream %s failed: %s", source.provider, cursor.segment_key, code)
        return report

    # ── the two destinations ───────────────────────────────────────────────
    #
    # A driver's payload lands EITHER in the graph as a record or on disk as an
    # asset, never both. `ingest_items` stays the single chokepoint for
    # SourceItem writes — reflection is a second destination beside it, not a
    # branch inside it, so that invariant survives a source whose payload is a
    # file.
    #
    # Which one is chosen by the SOURCE (`reflect`), not the driver: the same
    # folder could reasonably be mirrored as records or as assets, and a driver
    # that decided this would be deciding a policy question with only transport
    # knowledge.
    if not result.unchanged and result.items:
        report = await ingest_items(
            result.items,
            mode=IngestMode.for_run(first_run=view.first_run, item_count=len(result.items)),
        )
    if not result.unchanged and (result.refs or result.tombstones):
        await reflect_refs(
            source, list(result.refs), list(result.tombstones), dict(result.renames)
        )

    # ── records are committed; only now does the cursor move ──
    was_clean = (
        cursor.health == SourceHealth.OK.value
        and not cursor.consecutive_failures
        and (cursor.state or {}) == (result.next_state or {})
        and not result.high_water
    )
    cursor.state = result.next_state or {}
    if result.high_water:
        cursor.high_water = result.high_water
    cursor.last_synced_at = now
    cursor.health = SourceHealth.OK.value
    cursor.error_code = None
    cursor.error_detail = None
    cursor.consecutive_failures = 0

    # A stream that was already healthy and returned nothing new has no state
    # worth persisting — writing it anyway would put one SQLite writer-lock
    # acquisition per feed per tick on the floor forever, and would falsify the
    # "one request, zero writes" steady state the digest gate exists to give.
    # `last_attempted_at` stays in memory; the round-robin degrades gracefully
    # across a restart.
    if not (result.unchanged and was_clean):
        await cursor.save()
    return report


async def _cursors_for(source: DataSource, driver) -> list[DataSourceCursor]:
    """One query for the source's cursors, creating only what is missing.

    Per-stream ``ensure_for`` would be a read per feed per tick even though the
    budget only fetches a few of them.
    """
    existing = {
        c.segment_key: c
        for c in await DataSourceCursor.get_all({"data_source_id": source.id})
    }
    out: list[DataSourceCursor] = []
    # A builtin answers synchronously from config; a script-backed source has to
    # spawn its module to know. Tolerating both here keeps the Protocol's sync
    # signature true for the nine classes that satisfy it.
    refs = driver.segments(source)
    if inspect.isawaitable(refs):
        refs = await refs
    for ref in refs:
        cursor = existing.get(ref.key)
        if cursor is None:
            cursor = await DataSourceCursor.ensure_for(
                source.id, ref.key, segment_label=ref.label
            )
        out.append(cursor)
    return [c for c in out if c.enabled]


def _round_robin(cursors: list[DataSourceCursor], budget: int) -> list[DataSourceCursor]:
    """The ``budget`` streams that have waited longest.

    Never-attempted streams sort first, so a newly added feed is picked up on
    the next tick rather than starving behind healthy ones.
    """
    if budget <= 0:
        return []
    ordered = sorted(
        cursors,
        key=lambda c: (c.last_attempted_at is not None, c.last_attempted_at or datetime.min),
    )
    return ordered[:budget]


async def _roll_up(source: DataSource, cursors: list[DataSourceCursor], now: datetime) -> None:
    # Free: this row is being written anyway, and it saves every list surface
    # from watching the cursor table live just to render a count.
    source.segment_count = len(cursors)
    health = worst_of([c.health for c in cursors])
    source.health = health.value
    offender = next(
        (c for c in cursors if c.health == health.value and c.error_code), None
    )
    source.error_code = offender.error_code if offender else None
    source.error_detail = offender.error_detail if offender else None
    if health is SourceHealth.OK:
        source.last_synced_at = now
    source.schedule_next(now)
    await source.save()


async def _fail_source(source: DataSource, code: str, detail: str) -> None:
    source.health = SourceHealth.CONFIG_ERROR.value
    source.error_code = code
    source.error_detail = detail
    emit_sync_tag(
        source.provider, source.id, "failed", error_code=code, error_detail=detail
    )
    source.schedule_next(datetime.now(timezone.utc))
    await source.save()
