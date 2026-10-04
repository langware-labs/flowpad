"""A burst of ``stream_inbox.touch`` runs the unread recompute once more, not once per touch.

The recompute is a whole-table scan; a projected message touches once, so a run per touch made
a burst of N messages cost N scans and the burst landed in quadratic time (120 seeded messages:
~50s, growing per message). It reads canonical rows, so one trailing run converges.
"""
from __future__ import annotations

import asyncio

import pytest

import flow_sdk.stream_inbox as stream_inbox

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


async def test_touches_during_a_recompute_coalesce_into_one_more_run(monkeypatch):
    runs: list[str] = []
    gate = asyncio.Event()

    async def recompute(reason: str, owner=None):
        runs.append(reason)
        if len(runs) == 1:
            await gate.wait()

    monkeypatch.setattr(stream_inbox, "recompute_unread", recompute)

    stream_inbox.touch("first")
    await asyncio.sleep(0)
    for _ in range(50):
        stream_inbox.touch("burst")
    gate.set()
    for _ in range(20):
        await asyncio.sleep(0)

    assert len(runs) == 2, runs

    # Idle again: the next touch schedules its own run.
    stream_inbox.touch("later")
    for _ in range(20):
        await asyncio.sleep(0)
    assert len(runs) == 3, runs


async def test_a_failed_recompute_does_not_wedge_later_touches(monkeypatch):
    runs: list[str] = []

    async def recompute(reason: str, owner=None):
        runs.append(reason)
        raise RuntimeError("boom")

    monkeypatch.setattr(stream_inbox, "recompute_unread", recompute)

    stream_inbox.touch("one")
    for _ in range(20):
        await asyncio.sleep(0)
    stream_inbox.touch("two")
    for _ in range(20):
        await asyncio.sleep(0)
    assert runs == ["one", "two"]
