"""Attention-driven polling, request-based — and the tick-grid schedule.

Born from the "hi sat 5 minutes" incident and its RCA. Two promises:

* ``request_poll`` — the verb a SELECTED view fires on an interval — makes a
  healthy ACTIVE source due on the next tick and nothing else: it never
  un-latches ``config_error`` (that stays ``poll_now``'s job) and never wakes
  a DISABLED source. The request stream is the liveness signal; there is no
  stored active/idle state at all.

* ``schedule_next`` stamps on the MINUTE GRID the heartbeat ticks on. The old
  ``now + interval`` carried the dispatcher's millisecond jitter, and a tick
  firing a few ms earlier than the stamp silently skipped the source for a
  whole minute (RCA-proven both directions by moving ``next_poll_at`` across
  a tick boundary) — a 60s interval was really a 60/120s coin flip.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.ingest.health import SourceHealth

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)


async def _source(**kw) -> DataSource:
    base = dict(provider="rss", account_key=f"acct-{uuid.uuid4().hex[:8]}", name="Feed")
    base.update(kw)
    src = DataSource(**base)
    await src.save()
    return src


class TestRequestPoll:
    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_it_makes_a_healthy_source_due(self):
        src = await _source()
        src.schedule_next(NOW)  # a schedule minutes out must not delay attention
        await src.save()
        out = await src.request_poll_action()
        assert out.data["status"] == "due"
        assert src.next_poll_at is None, "due on the next tick — unconditionally"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_it_is_idempotent_on_an_already_due_source(self):
        src = await _source()
        assert src.next_poll_at is None
        out = await src.request_poll_action()
        assert out.data["status"] == "due"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_attention_never_unlatches_config_error(self):
        # poll_now un-latches on purpose; the auto-firing viewer must NOT —
        # a broken credential outranks a mounted view, or the UI would burn
        # quota re-learning the same error every 25 seconds.
        src = await _source()
        src.health = SourceHealth.CONFIG_ERROR.value
        src.schedule_next(NOW)
        await src.save()
        out = await src.request_poll_action()
        assert out.data["status"] == "ignored"
        assert src.health == SourceHealth.CONFIG_ERROR.value
        assert src.next_poll_at is not None, "a parked source must not become due"
        assert src.is_due(NOW) is False

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_attention_never_wakes_a_disabled_source(self):
        src = await _source(status=SourceStatus.DISABLED.value)
        src.schedule_next(NOW)
        await src.save()
        out = await src.request_poll_action()
        assert out.data["status"] == "ignored"
        assert src.is_due(NOW) is False

    def test_the_action_is_reachable_over_http_not_just_callable(self):
        # Same pin as the sibling actions: the dispatcher must know it, and
        # its signature must declare nothing the dispatcher would have to fill.
        import inspect

        from flow_sdk.actions.action_registry import action as registry

        assert "data_source.request_poll" in set(registry.function_registry)
        params = set(inspect.signature(DataSource.request_poll_action).parameters) - {"self"}
        assert not params


class TestTickGridSchedule:
    def test_the_stamp_lands_on_the_minute_grid(self):
        # The RCA's switch: a stamp of :00.031 vs a tick firing :00.019 —
        # 12ms apart — cost a full minute. Flooring removes the coin flip.
        src = DataSource(provider="rss", name="f", poll_interval_seconds=60)
        jittered_now = NOW + timedelta(milliseconds=31)  # a real dispatch time
        due = src.schedule_next(jittered_now)
        assert due == NOW + timedelta(seconds=60)
        assert due.second == 0 and due.microsecond == 0

    def test_a_one_tick_interval_means_every_tick(self):
        # The next tick fires at :00 plus SMALLER jitter than the stamp's —
        # the exact losing coin flip. On the grid, it is always due.
        src = DataSource(
            provider="rss", name="f", poll_interval_seconds=60,
            status=SourceStatus.ACTIVE.value,  # is_due gates on lifecycle first
        )
        src.schedule_next(NOW + timedelta(milliseconds=31))
        next_tick = NOW + timedelta(seconds=60, milliseconds=19)
        assert src.is_due(next_tick) is True

    def test_longer_intervals_keep_their_cadence(self):
        src = DataSource(provider="rss", name="f", poll_interval_seconds=300)
        due = src.schedule_next(NOW + timedelta(seconds=3, milliseconds=200))
        assert due == NOW + timedelta(seconds=300), "mid-minute drift floors back to the grid"
