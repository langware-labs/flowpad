"""The index slot is single-flight, and a second caller QUEUES rather than 409s.

The server claims that slot at boot for the system-asset pass and reports
itself healthy while it runs, so the first client to ask for an index landed
inside a window it could neither see nor influence and was refused. Joining is
not enough on its own — the two runs cover different scopes — so a waiter takes
the slot when it frees and then does its own work.
"""
from __future__ import annotations

import asyncio

import pytest

from flow_sdk.builtin.faas.compute_node import ComputeNode


@pytest.fixture
def node() -> ComputeNode:
    return ComputeNode(name="activity-fixture")


def test_a_second_claim_is_refused_while_the_first_holds(node):
    node._start_activity("index", timeout_seconds=600)
    try:
        with pytest.raises(RuntimeError, match="already running"):
            node._start_activity("index")
    finally:
        node._complete_activity("index")


def test_releasing_wakes_a_waiter_and_frees_the_slot(node):
    """The waiter must WAKE on the release, not on a poll of its own choosing —
    and must then be able to claim, since its own scope is still unindexed."""

    async def scenario():
        held = node._start_activity("index", timeout_seconds=600)
        holder = node._running_activity("index")
        assert holder is held, "the slot must report the activity holding it"

        woke = asyncio.Event()

        async def waiter():
            await holder.wait_released()
            woke.set()
            return node._start_activity("index", timeout_seconds=600)

        task = asyncio.create_task(waiter())
        await asyncio.sleep(0)
        assert not woke.is_set(), "the waiter must not proceed while the slot is held"

        node._complete_activity("index")
        claimed = await task
        assert woke.is_set()
        assert claimed is not held, "the waiter runs its own pass, not the holder's"
        node._complete_activity("index")

    asyncio.run(scenario())


def test_the_slot_reads_free_once_released(node):
    node._start_activity("index", timeout_seconds=600)
    node._complete_activity("index")
    assert node._running_activity("index") is None


def test_waiting_is_bounded_by_the_holders_own_timeout(node):
    """No second budget: a holder that dies without releasing is bounded by the
    same `timeout_seconds` that makes `_start_activity` treat it as stale."""

    async def scenario():
        node._start_activity("index", timeout_seconds=0)
        assert node._running_activity("index") is None, "a timed-out holder holds nothing"
        # Never released, yet the wait returns rather than hanging on it.
        stale = node._start_activity("index", timeout_seconds=0)
        await asyncio.wait_for(stale.wait_released(), timeout=5)
        node._complete_activity("index")

    asyncio.run(scenario())
