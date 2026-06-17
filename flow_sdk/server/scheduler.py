"""APScheduler singleton for CronEvent scheduling."""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)

_scheduler = None
_job_registration_lock = asyncio.Lock()


def get_scheduler():
    """Get or create the global AsyncIOScheduler instance."""
    global _scheduler
    if _scheduler is None:
        try:
            from pathlib import Path
            from apscheduler.schedulers.asyncio import AsyncIOScheduler
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

            _scheduler = AsyncIOScheduler(
                jobstores={
                    "default": SQLAlchemyJobStore(url=f"sqlite:///{jobstore_path}")
                },
                job_defaults={"misfire_grace_time": 60},
            )
        except ImportError as e:
            logger.warning(f"APScheduler not available: {e}")
            return None
    return _scheduler


def start_scheduler():
    """Start the scheduler if not already running."""
    scheduler = get_scheduler()
    if scheduler is None:
        return
    if not scheduler.running:
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
