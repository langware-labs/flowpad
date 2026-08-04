"""The poll dispatcher: due-selection, no stacking, pre-scheduling, registration.

An injected clock and an injected spawn throughout — no sleeping, no racing a
real event loop, and no network. The dispatcher's whole job is selection, so
selection is what these assert.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest import poller
from flow_sdk.ingest.health import SourceHealth

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)


async def _source(**kw) -> DataSource:
    account = f"acct-{uuid.uuid4().hex[:8]}"
    fields = {
        "provider": "faketest",
        "account_key": account,
        "name": "poll fixture",
        # Far future by default so unrelated rows from other tests never make a
        # given assertion flaky.
        "next_poll_at": NOW + timedelta(days=365),
    }
    fields.update(kw)
    src = DataSource(
        **fields,
    )
    await src.save()
    return src


class _Spawn:
    """Records what would have been backgrounded, and never runs it."""

    def __init__(self):
        self.count = 0

    def __call__(self, coro):
        self.count += 1
        coro.close()  # we are not executing the poll here
        return None   # no add_done_callback → dispatcher clears _inflight itself


@pytest.fixture(autouse=True)
def _clear_inflight():
    poller._inflight.clear()
    yield
    poller._inflight.clear()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_only_due_sources_are_dispatched():
    due = await _source(next_poll_at=NOW - timedelta(seconds=1))
    later = await _source(next_poll_at=NOW + timedelta(hours=1))
    disabled = await _source(enabled=False, next_poll_at=NOW - timedelta(seconds=1))
    broken = await _source(
        next_poll_at=NOW - timedelta(seconds=1), health=SourceHealth.CONFIG_ERROR.value
    )

    spawn = _Spawn()
    dispatched = await poller.dispatch_due_sources(now_fn=lambda: NOW, spawn=spawn)

    assert due.id in dispatched
    assert later.id not in dispatched
    assert disabled.id not in dispatched, "a disabled source must never poll"
    assert broken.id not in dispatched, (
        "a config_error source needs a human; re-polling burns quota to re-learn it"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_source_already_in_flight_is_not_stacked():
    src = await _source(next_poll_at=NOW - timedelta(seconds=1))
    poller._inflight.add(src.id)

    dispatched = await poller.dispatch_due_sources(now_fn=lambda: NOW, spawn=_Spawn())
    assert src.id not in dispatched, (
        "a slow source was dispatched again while still running — polls would stack"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_dispatcher_does_no_io_itself():
    """It must return in milliseconds — the heartbeat budget is 5s, enforced."""
    import time

    await _source(next_poll_at=NOW - timedelta(seconds=1))
    started = time.monotonic()
    await poller.dispatch_due_sources(now_fn=lambda: NOW, spawn=_Spawn())
    elapsed = time.monotonic() - started

    assert elapsed < 1.0, (
        f"dispatch took {elapsed:.2f}s; it must hand work off, not perform it — "
        "system_heartbeat cancels a task at TASK_TIMEOUT_SECONDS"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_next_poll_is_pushed_out_before_any_io():
    """A crash mid-poll must cost one interval, not produce a hot loop."""
    src = await _source(next_poll_at=NOW - timedelta(seconds=1), poll_interval_seconds=300)

    # _run_poll pre-schedules, then syncs. sync_source will fail cleanly on the
    # unregistered provider; what matters is the pre-schedule already landed.
    await poller._run_poll(src, NOW)

    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.next_poll_at is not None
    assert refreshed.is_due(NOW) is False, "the source is still immediately due — hot loop"


def test_the_task_is_registered_under_the_heartbeat():
    from flow_sdk.server.system_heartbeat import _registered_tasks

    assert "data_source_poll" in _registered_tasks(), (
        "the poller module was imported but its decorator did not register — "
        "check the lazy import in server/builtin_triggers.py"
    )


def test_builtin_triggers_imports_the_poller():
    """The registration only happens if boot actually imports the module."""
    from flow_sdk.server.builtin_triggers import _service_trigger_specs
    from flow_sdk.server.system_heartbeat import _registered_tasks

    _service_trigger_specs()
    assert "data_source_poll" in _registered_tasks()
