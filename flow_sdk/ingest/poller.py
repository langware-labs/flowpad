"""The poll dispatcher — one heartbeat task, no scheduler jobs.

**Why the heartbeat and not a SCHEDULE Trigger per source.** The orphan-job
incident recorded in ``prune_orphan_scheduler_jobs`` (27 stale jobs, ~63% CPU,
560 fires/min starving HTTP and WS) is a property of *per-entity jobstore rows*.
A source-per-job design reproduces exactly that shape: N sources, N rows, N
chances for a delete to leave one behind. A heartbeat task cannot orphan —
there is nothing in ``scheduler_jobs.db`` to orphan and no per-wakeup
``update_job`` write. The minute cadence also happens to be the tightest
provider floor we care about.

**This task must never do I/O.** ``TASK_TIMEOUT_SECONDS`` is 5.0 and enforced
by ``asyncio.wait_for``; a network poll would blow it and be cancelled
mid-write. Raising that constant is not available to us and would be wrong
anyway — one slow feed would then starve every other housekeeping task. So the
task selects what is due, hands each source to its own background task, and
returns in milliseconds.

``_inflight`` is the entire concurrency control: one poll per source at a time.
No locks, no timeouts, no backoff.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Callable, Optional

from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.server.system_heartbeat import register_heartbeat_task

logger = logging.getLogger(__name__)

#: Source ids with a poll in flight. A source that takes longer than the tick
#: interval is skipped rather than stacked.
_inflight: set[str] = set()

# ── the attention fast lane ──────────────────────────────────────────────────
# Sub-tick polling for a source someone is WATCHING. `request_poll` renews a
# short lease; while any lease is live, one loop task polls each leased source
# at its driver's `attention_poll_seconds`. The lease expires shortly after
# the UI's request stream stops (the stream is the liveness signal — same
# principle as `request_poll` itself), so a vanished viewer costs at most one
# lease of fast polling and the loop task exits when the table empties.
# `_inflight` stays the single concurrency control, so the tick lane and the
# fast lane can never poll one source concurrently.

#: How long one `request_poll` keeps the fast lane armed. The UI requests
#: every ~25s while a view is selected, so a live viewer renews well inside
#: this; it is a liveness window, not a cadence knob.
ATTENTION_LEASE_SECONDS = 35.0

#: source id → {"expiry": monotonic, "cadence": seconds, "next": monotonic}
_attention: dict[str, dict] = {}
_attention_tasks: "dict[object, asyncio.Task]" = {}


def note_attention(source_id: str, cadence_seconds: int) -> None:
    """Arm or renew the fast lane for one source; start the loop on first use.

    Called by ``request_poll`` after its own gates (``poll_refusal``), so the
    lane never needs to re-litigate whether the source may poll at all —
    it still re-checks each round, because a source can park mid-lease.
    """
    now = time.monotonic()
    entry = _attention.get(source_id)
    _attention[source_id] = {
        "expiry": now + ATTENTION_LEASE_SECONDS,
        "cadence": max(1, int(cadence_seconds)),
        # A renewal must not delay the round already scheduled.
        "next": entry["next"] if entry else now,
    }
    loop = asyncio.get_running_loop()
    task = _attention_tasks.get(loop)
    if task is None or task.done():
        _attention_tasks[loop] = asyncio.ensure_future(_attention_loop())


async def _attention_loop() -> None:
    """Poll every leased source at its cadence until all leases lapse."""
    while _attention:
        now = time.monotonic()
        for source_id, lease in list(_attention.items()):
            if lease["expiry"] <= now:
                _attention.pop(source_id, None)
                continue
            if lease["next"] > now or source_id in _inflight:
                continue
            lease["next"] = now + lease["cadence"]
            source = await DataSource.get_by_id(source_id)
            if source is None or source.poll_refusal():
                _attention.pop(source_id, None)  # parked mid-lease — lane off
                continue
            _inflight.add(source_id)
            asyncio.ensure_future(_run_poll(source, datetime.now(timezone.utc)))
        # Sleep to the nearest upcoming edge (a due round or a lease expiry)
        # instead of a fixed 1s spin — most wakeups were dead time under a 5s
        # cadence. Clamped so a renewal arming a fresh "due now" round never
        # waits long, and an inflight-skipped source retries promptly.
        edges = [min(l["next"], l["expiry"]) for l in _attention.values()]
        if edges:
            await asyncio.sleep(min(max(min(edges) - time.monotonic(), 0.25), 5.0))


async def dispatch_due_sources(
    *,
    now_fn: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    spawn: Optional[Callable] = None,
) -> list[str]:
    """Select due sources and hand each to a background task.

    Returns the ids dispatched — for tests and for the log line. ``now_fn`` and
    ``spawn`` are injected so this is testable without sleeping or racing a
    real event loop.
    """
    now = now_fn()
    spawn = spawn or asyncio.ensure_future
    dispatched: list[str] = []

    try:
        # ACTIVE only. NEW and SETUP have not finished being configured — a
        # Slack source whose bot was never invited would otherwise be polled
        # every minute to re-learn that.
        sources = await DataSource.get_all({"status": SourceStatus.ACTIVE.value})
    except Exception:  # noqa: BLE001 — a housekeeping tick must never raise
        logger.debug("[ingest] could not list data sources", exc_info=True)
        return dispatched

    for source in sources:
        if source.id in _inflight:
            continue
        if not source.is_due(now):
            continue
        # Dispatch even when a capability is missing: `sync_source` records it
        # as `capability_unavailable` / config_error, which is what surfaces the
        # "Parked — needs attention" banner. Skipping silently here left a
        # gated source sitting at `never_synced`, looking healthy, never
        # polling, with nothing anywhere explaining why.
        _inflight.add(source.id)
        dispatched.append(source.id)
        spawn(_run_poll(source, now))

    return dispatched


async def _run_poll(source: DataSource, now: datetime) -> None:
    """Owns its own slot: whatever happens, the source is released."""
    try:
        # Push the next due time out BEFORE any I/O. If this process dies
        # mid-poll, the source waits one interval on restart instead of being
        # re-picked — and re-crashed — on every tick.
        try:
            source.schedule_next(now)
            await source.save()
        except Exception:  # noqa: BLE001
            logger.debug("[ingest] could not pre-schedule %s", source.id, exc_info=True)

        from flow_sdk.ingest.sync import sync_source  # noqa: PLC0415

        await sync_source(source, now=now)
    except Exception:  # noqa: BLE001 — sync_source classifies its own failures;
        # anything reaching here is a bug, and it must not kill the poller.
        logger.warning("[ingest] poll failed for %s", source.id, exc_info=True)
    finally:
        _inflight.discard(source.id)


@register_heartbeat_task("data_source_poll")
async def _heartbeat_dispatch() -> None:
    import flow_sdk.ingest.drivers  # noqa: F401, PLC0415 — register shipped drivers
    from flow_sdk.ingest.spec_registry import refresh_spec_drivers  # noqa: PLC0415

    # Authored sources come from rows, not imports, so the registry is swept
    # here — a spec written or edited on disk is live within one cadence.
    await refresh_spec_drivers()

    dispatched = await dispatch_due_sources()
    if dispatched:
        logger.info("[ingest] dispatched %d source(s)", len(dispatched))
