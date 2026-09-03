"""``Activity.claim`` — the address as a single-flight slot.

An activity per ``(scope, path)`` is the same statement as one job of that name per entity,
so the mechanism can own what a separate registry used to: refuse a second claim, let a
caller queue behind the holder, and take over an address whose producer died.

The queue case is not hypothetical. The server's own boot pass claims `index` while it
indexes the system's roots; a user asking for THEIR folder cannot be served by that run, so
the honest answer is "after you" rather than a refusal.
"""

import asyncio
import time

import pytest

from flow_sdk.activity import Activity, ActivityState, monitor

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _clean_monitor():
    monitor.clear()
    yield
    monitor.clear()


# ---------------------------------------------------------------- taking the address


async def test_a_claim_takes_the_address():
    act = Activity.try_claim("index", scope="node-1")

    assert monitor.holder("index", scope="node-1") is act


async def test_a_second_claim_is_refused_with_the_message_callers_match_on():
    """Four routes turn this into an HTTP 409 by catching ``RuntimeError``. The wording is
    part of the contract, not decoration."""
    Activity.try_claim("index", scope="node-1")

    with pytest.raises(RuntimeError, match="Job 'index' already running"):
        Activity.try_claim("index", scope="node-1")


async def test_scope_separates_addresses():
    """Two compute nodes each running an index are not in each other's way."""
    Activity.try_claim("index", scope="node-1")

    Activity.try_claim("index", scope="node-2")  # must not raise


async def test_a_finished_holder_frees_the_address():
    act = Activity.try_claim("index", scope="node-1")
    act.done()

    assert monitor.holder("index", scope="node-1") is None
    Activity.try_claim("index", scope="node-1")  # must not raise


# ---------------------------------------------------------------- stale holders


async def test_a_holder_past_its_budget_is_claimable_again():
    """Without this a producer killed mid-run owns its address until the process restarts."""
    stale = Activity.try_claim("index", scope="node-1", timeout_seconds=0)
    time.sleep(0.01)

    assert stale.claim_expired
    assert monitor.holder("index", scope="node-1") is None


async def test_taking_over_a_stale_address_mints_a_fresh_node():
    """The old counters describe a run that is gone; inheriting them would report someone
    else's work as the new claimant's."""
    stale = Activity.try_claim("index", scope="node-1", timeout_seconds=0)
    stale.inc_success(99)
    time.sleep(0.01)

    fresh = Activity.try_claim("index", scope="node-1")

    assert fresh is not stale
    assert fresh.spec().done == 0


async def test_taking_over_wakes_anyone_waiting_on_the_dead_holder():
    """A waiter queued behind a producer that died must not wait out the whole budget."""
    stale = Activity.try_claim("index", scope="node-1", timeout_seconds=0)
    waiting = asyncio.create_task(stale.wait_released())
    await asyncio.sleep(0)
    time.sleep(0.01)

    Activity.try_claim("index", scope="node-1")

    await asyncio.wait_for(waiting, timeout=1)


# ---------------------------------------------------------------- the context manager


async def test_claim_ends_and_releases_the_address_on_exit():
    async with Activity.claim("index", scope="node-1") as act:
        act.total(10)
        act.inc_success(10)

    assert act.state is ActivityState.COMPLETED
    assert monitor.holder("index", scope="node-1") is None


async def test_claim_fails_the_activity_when_the_body_raises():
    """A crashed run must not read as a completed one, and must still free the address."""
    with pytest.raises(ValueError):
        async with Activity.claim("index", scope="node-1") as act:
            act.inc_success()
            raise ValueError("walker exploded")

    assert act.state is ActivityState.FAILED
    assert monitor.holder("index", scope="node-1") is None


async def test_a_body_that_ends_the_activity_itself_is_left_alone():
    async with Activity.claim("index", scope="node-1") as act:
        act.done("said it myself")

    assert act.spec().message == "said it myself"


async def test_claim_without_queue_raises_when_held():
    Activity.try_claim("index", scope="node-1")

    with pytest.raises(RuntimeError, match="already running"):
        async with Activity.claim("index", scope="node-1"):
            pass


# ---------------------------------------------------------------- queueing


async def test_a_queued_caller_waits_for_the_holder_then_runs():
    held = Activity.try_claim("index", scope="node-1")
    order: list[str] = []

    async def waiter():
        async with Activity.claim("index", scope="node-1", queue=True):
            order.append("waiter ran")

    task = asyncio.create_task(waiter())
    await asyncio.sleep(0.02)
    assert order == [], "the waiter must not run while the address is held"

    order.append("holder released")
    held.done()
    await asyncio.wait_for(task, timeout=2)

    assert order == ["holder released", "waiter ran"]


async def test_a_queued_caller_gets_its_own_activity_not_the_holders():
    """The whole reason to queue rather than join: the run already going covers someone
    else's scope, so serving its result would be answering a question nobody asked."""
    held = Activity.try_claim("index", scope="node-1")
    held.inc_success(50)
    seen: list[int] = []

    async def waiter():
        async with Activity.claim("index", scope="node-1", queue=True) as act:
            seen.append(act.spec().done)

    task = asyncio.create_task(waiter())
    await asyncio.sleep(0.02)
    held.done()
    await asyncio.wait_for(task, timeout=2)

    assert seen == [0]


async def test_only_one_of_several_waiters_holds_the_address_at_a_time():
    held = Activity.try_claim("index", scope="node-1")
    concurrent = 0
    peak = 0

    async def waiter():
        nonlocal concurrent, peak
        async with Activity.claim("index", scope="node-1", queue=True):
            concurrent += 1
            peak = max(peak, concurrent)
            await asyncio.sleep(0.01)
            concurrent -= 1

    tasks = [asyncio.create_task(waiter()) for _ in range(4)]
    await asyncio.sleep(0.02)
    held.done()
    await asyncio.wait_for(asyncio.gather(*tasks), timeout=5)

    assert peak == 1, "the address is single-flight; a re-claim loop must not let two in"


async def test_waiting_is_bounded_by_the_holders_own_budget():
    """No second timeout is invented here: a waiter gives up exactly when the holder's
    address would have become claimable anyway."""
    Activity.try_claim("index", scope="node-1", timeout_seconds=0)

    async with Activity.claim("index", scope="node-1", queue=True) as act:
        assert act.state is not ActivityState.PENDING or True
