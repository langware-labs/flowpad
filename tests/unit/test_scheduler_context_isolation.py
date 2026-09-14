"""A scheduled job must never run in the context that scheduled it.

The failure this pins: a schedule armed from inside a DB session (the index's
post-sync hook) fired on time and started its agent, yet neither the process
row nor the trigger's counter ever existed, and every other writer then hit
``database is locked``. Stock ``AsyncIOScheduler`` wakes via
``call_soon_threadsafe``/``call_later``, which snapshot the caller's
contextvars — so the job inherited the sqlite driver's "already in a session"
marker and wrote into a session that had been committed and closed.

The lever is the scheduler class: the stock one leaks the caller's context into
the job, ``IsolatedAsyncIOScheduler`` does not.
"""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone

import pytest
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.date import DateTrigger

from flow_sdk.server.scheduler import IsolatedAsyncIOScheduler

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

_caller_state: ContextVar[str | None] = ContextVar("caller_state", default=None)


async def _value_seen_by_job(scheduler_cls) -> str | None:
    scheduler = scheduler_cls()
    scheduler.start()
    seen: list[str | None] = []
    done = asyncio.Event()

    async def job() -> None:
        seen.append(_caller_state.get())
        done.set()

    token = _caller_state.set("the caller's open session")
    try:
        # Scheduled FROM INSIDE the caller's context, to fire after it has ended.
        scheduler.add_job(job, DateTrigger(run_date=datetime.now(timezone.utc) + timedelta(milliseconds=50)))
    finally:
        _caller_state.reset(token)
    try:
        await done.wait()
    finally:
        scheduler.shutdown(wait=False)
    return seen[0]


@pytest.mark.asyncio
async def test_the_stock_scheduler_leaks_the_callers_context_into_the_job():
    """The lever's OFF position — why the subclass exists."""
    assert await _value_seen_by_job(AsyncIOScheduler) == "the caller's open session"


@pytest.mark.asyncio
async def test_a_job_runs_in_the_schedulers_own_context_not_the_callers():
    assert await _value_seen_by_job(IsolatedAsyncIOScheduler) is None


def test_the_instance_scheduler_is_the_isolated_one():
    from flow_sdk.server import scheduler as module

    assert module.IsolatedAsyncIOScheduler.__mro__[1] is AsyncIOScheduler
    source = module.get_scheduler.__code__.co_names
    assert "IsolatedAsyncIOScheduler" in source
