"""APScheduler singleton for CronEvent scheduling."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_scheduler = None


def get_scheduler():
    """Get or create the global AsyncIOScheduler instance."""
    global _scheduler
    if _scheduler is None:
        try:
            from apscheduler.schedulers.asyncio import AsyncIOScheduler
            from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
            from flow_sdk.db.drivers.sqlite.connection import get_database_path

            _scheduler = AsyncIOScheduler(
                jobstores={
                    "default": SQLAlchemyJobStore(url=f"sqlite:///{get_database_path()}")
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
