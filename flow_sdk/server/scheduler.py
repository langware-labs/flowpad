"""APScheduler singleton for CronEvent scheduling."""

from __future__ import annotations

import asyncio
import contextvars
import logging

logger = logging.getLogger(__name__)

_scheduler = None
_job_registration_lock = asyncio.Lock()

try:
    from apscheduler.schedulers.asyncio import AsyncIOScheduler as _AsyncIOScheduler
except ImportError:  # pragma: no cover — get_scheduler reports the missing dependency
    _AsyncIOScheduler = object  # type: ignore[assignment,misc]


class IsolatedAsyncIOScheduler(_AsyncIOScheduler):
    """An AsyncIOScheduler whose jobs never run in the context that scheduled them.

    Stock ``AsyncIOScheduler.wakeup`` is ``call_soon_threadsafe(...)`` and its
    timer is ``call_later(...)`` — both snapshot the CALLER's contextvars, and
    every later timer is re-armed from inside that snapshot. So a job added
    during a request or an index sync fires, and keeps firing, inside that
    caller's context: including ``_standalone_session_var``, the sqlite driver's
    "you are already inside a session" marker. The fired job's writes then join a
    session that was committed and closed long ago — they open a transaction no
    one commits, the rows never land, and the held write lock turns every other
    writer's next attempt into ``database is locked``.

    Seen for real: a schedule armed by ``arm_after_index`` (a post-sync hook,
    i.e. inside ``FSRecord._sync_to_db``'s session) fired on time, started its
    agent, and neither the process row nor the trigger's counter ever existed.

    The fix is at the source: wakeups and timers run in the context captured
    when the scheduler STARTED (app startup — no request, no session), a fresh
    copy per callback so no two callbacks ever enter the same Context object.
    """

    _context: "contextvars.Context | None" = None

    def start(self, paused=False):
        self._context = contextvars.copy_context()
        super().start(paused)

    def _scheduler_context(self) -> "contextvars.Context":
        return (self._context or contextvars.Context()).copy()

    def wakeup(self):
        if self._eventloop is None:
            return
        self._eventloop.call_soon_threadsafe(self._wakeup_now, context=self._scheduler_context())

    def _wakeup_now(self):
        self._stop_timer()
        wait_seconds = self._process_jobs()
        self._start_timer(wait_seconds)

    def _start_timer(self, wait_seconds):
        self._stop_timer()
        if wait_seconds is not None:
            self._timeout = self._eventloop.call_later(
                wait_seconds, self.wakeup, context=self._scheduler_context()
            )


def get_scheduler():
    """Get or create the global AsyncIOScheduler instance."""
    global _scheduler
    if _scheduler is None:
        try:
            from pathlib import Path

            from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore

            from flow_sdk.db.drivers.sqlite.connection import get_database_path

            # Persist scheduler jobs in their OWN SQLite file, NOT the app DB.
            # SQLite is single-writer-per-file: when the jobstore shared the app
            # DB, its per-wakeup update_job writes contended with app writes and
            # raised "database is locked" under load. A dedicated file removes
            # the contention at its source (the scheduler is the sole writer)
            # while keeping job persistence across restarts. Per-instance,
            # since get_database_path() is per-instance.
            jobstore_path = str(Path(get_database_path()).with_name("scheduler_jobs.db"))

            _scheduler = IsolatedAsyncIOScheduler(
                jobstores={"default": SQLAlchemyJobStore(url=f"sqlite:///{jobstore_path}")},
                job_defaults={"misfire_grace_time": 60},
            )
        except ImportError as e:
            logger.warning(f"APScheduler not available: {e}")
            return None
    return _scheduler


def _log_missed_job(event) -> None:
    """A missed run is the one in-process signal that the event loop stalled.

    APScheduler notices the miss as soon as the loop comes back, so this fires
    from inside the stall window — the moment worth measuring. The job itself is
    rarely the problem; record what the machine looked like instead.
    """
    from flow_sdk.server.memory_probe import memory_snapshot

    logger.warning("Scheduler job %s missed its run time | %s", event.job_id, memory_snapshot())


def start_scheduler():
    """Start the scheduler if not already running."""
    scheduler = get_scheduler()
    if scheduler is None:
        return
    if not scheduler.running:
        from apscheduler.events import EVENT_JOB_MISSED

        scheduler.add_listener(_log_missed_job, EVENT_JOB_MISSED)
        scheduler.start()
        logger.info("CronEvent scheduler started")


def stop_scheduler():
    """Shut down the scheduler gracefully."""
    global _scheduler
    if _scheduler is not None and _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("CronEvent scheduler stopped")


async def acquire_job_registration_lock():
    """Acquire lock for thread-safe job registration."""
    return _job_registration_lock


async def prune_orphan_scheduler_jobs() -> int:
    """Remove APScheduler jobs whose id no longer maps to a live trigger entity.

    The jobstore (``scheduler_jobs.db``) is persistent across restarts. Every
    job is registered with ``id=<entity id>`` and ``replace_existing=True``
    (see ``Trigger._register_schedule_job`` / ``CronEvent``), so a live entity
    can only ever own a single job. But older builds added jobs with random
    ids, and a job whose owning entity is later deleted is never cleaned up —
    so stale jobs accumulate in the persistent store. They all fire every tick,
    each doing DB work through the SQLAlchemy greenlet bridge on the event loop:
    27 orphaned "System heartbeat" jobs once pinned the backend at ~63% CPU
    (560 fires/min) and starved all HTTP/WS handlers.

    Valid job ids are exactly the ids of schedule-type ``Trigger`` entities and
    ``CronEvent`` entities; anything else in the jobstore is an orphan and is
    removed. Call once at startup, after the scheduler is started and service
    triggers are registered.

    If the set of live ids cannot be determined (a DB error), nothing is pruned
    — we never delete on incomplete knowledge. Returns the number of jobs
    removed.
    """
    scheduler = get_scheduler()
    if scheduler is None or not scheduler.running:
        return 0

    # Collect the ids that legitimately own a job. Abort on any failure so a
    # transient DB error can never wipe valid jobs.
    try:
        from flow_sdk.builtin.cron_event import CronEvent
        from flow_sdk.builtin.trigger import Trigger
        from flow_sdk.schema.data_spec.trigger_types import TriggerType

        valid_ids: set[str] = {t.id for t in await Trigger.list_by_type(TriggerType.SCHEDULE) if t.id}
        valid_ids.update(c.id for c in await CronEvent.get_all() if getattr(c, "id", None))
    except Exception:
        logger.exception("prune_orphan_scheduler_jobs: could not resolve live job ids; skipping prune")
        return 0

    pruned = 0
    for job in scheduler.get_jobs():
        if job.id in valid_ids:
            continue
        try:
            scheduler.remove_job(job.id)
            pruned += 1
        except Exception:
            logger.exception("prune_orphan_scheduler_jobs: failed to remove job %s", job.id)

    if pruned:
        logger.warning("prune_orphan_scheduler_jobs: removed %d orphan job(s) from the jobstore", pruned)
    return pruned
