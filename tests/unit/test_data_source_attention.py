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

import asyncio
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


@pytest.fixture(autouse=True)
def _clean_attention_state():
    """The lane keeps its lease and in-flight sets in MODULE globals, so they
    outlive a test and are shared with every other file in the run.

    Clearing on teardown alone is not enough: a neighbour that leaves an entry
    behind hands this file a lane that is already busy, and a test waiting for
    its own source to drop off waits forever. Clear on the way in as well.
    """
    from flow_sdk.ingest import poller

    poller._attention.clear()
    poller._inflight.clear()
    yield
    poller._attention.clear()
    poller._inflight.clear()


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


class TestAttentionFastLane:
    """The sub-tick lane: request_poll on a driver that declares
    ``attention_poll_seconds`` arms a short lease and the poller's attention
    loop polls at that cadence; drivers that declare nothing stay tick-bound.
    The lease lapses when the request stream stops — the stream is the
    liveness signal, same as request_poll itself."""

    def teardown_method(self):
        from flow_sdk.ingest import poller

        poller._attention.clear()

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_declaring_driver_arms_the_lease(self, monkeypatch):
        import flow_sdk.ingest.drivers  # noqa: F401 — registers telegram
        from flow_sdk.ingest import poller

        async def _no_poll(source, now):
            poller._inflight.discard(str(source.id))

        monkeypatch.setattr(poller, "_run_poll", _no_poll)  # no network in a unit test
        src = await _source(provider="telegram", config={"bot_token": "t"})
        out = await src.request_poll_action()
        assert out.data["attention_seconds"] == 5
        assert str(src.id) in poller._attention
        assert poller._attention[str(src.id)]["cadence"] == 5

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_silent_driver_stays_tick_bound(self):
        from flow_sdk.ingest import poller

        src = await _source(provider="rss")
        out = await src.request_poll_action()
        assert out.data["attention_seconds"] is None
        assert str(src.id) not in poller._attention

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_the_loop_polls_at_cadence_and_expires_with_the_lease(self, monkeypatch):
        import time as _time

        import flow_sdk.ingest.drivers  # noqa: F401
        from flow_sdk.ingest import poller

        src = await _source(provider="telegram", config={"bot_token": "t"})
        polled: list[str] = []

        async def _fake_run_poll(source, now):
            polled.append(str(source.id))
            poller._inflight.discard(str(source.id))

        monkeypatch.setattr(poller, "_run_poll", _fake_run_poll)
        # Compress the loop's round sleep (1s → 20ms) and shrink the lease to
        # 2.5s so one full arm→poll→poll→lapse life cycle fits in ~3s of wall
        # clock. The cadence itself rides note_attention's 1s floor — the
        # loop's own arithmetic, untouched. This scales the test's clock; it
        # widens nothing to ride past a failure.
        real_sleep = asyncio.sleep
        monkeypatch.setattr(poller.asyncio, "sleep", lambda s: real_sleep(min(s, 0.02)))
        monkeypatch.setattr(poller, "ATTENTION_LEASE_SECONDS", 2.5)
        monkeypatch.setattr(
            "flow_sdk.ingest.drivers.telegram.TelegramDriver.attention_poll_seconds", 1
        )

        await src.request_poll_action()
        assert poller._attention[str(src.id)]["cadence"] == 1
        t0 = _time.monotonic()
        while poller._attention and _time.monotonic() - t0 < 8:
            await real_sleep(0.05)

        assert not poller._attention, "the lease must lapse when requests stop"
        assert len(polled) >= 2, "the lane must poll repeatedly at cadence within one lease"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_source_parked_mid_lease_drops_off_the_lane(self, monkeypatch):
        import flow_sdk.ingest.drivers  # noqa: F401
        from flow_sdk.ingest import poller
        from flow_sdk.ingest.health import SourceHealth

        async def _no_poll(source, now):
            poller._inflight.discard(str(source.id))

        monkeypatch.setattr(poller, "_run_poll", _no_poll)  # no network in a unit test
        src = await _source(provider="telegram", config={"bot_token": "t"})
        await src.request_poll_action()
        assert str(src.id) in poller._attention
        src.health = SourceHealth.CONFIG_ERROR.value
        await src.save()

        real_sleep = asyncio.sleep
        monkeypatch.setattr(poller.asyncio, "sleep", lambda s: real_sleep(min(s, 0.01)))
        # The lane re-checks a source when its NEXT round is due; the first
        # round already ran on arming, so the next one is a cadence away.
        # Make it due now — the mechanism under test is the re-check, not the
        # cadence. Ring the doorbell after, exactly as every production writer
        # of the schedule does: the loop reads the schedule once and then waits
        # on that answer, so a change made while it waits is invisible until
        # the bell returns it. Poking `next` without ringing is an incomplete
        # simulation, and it raced the loop's own wait — which is how this
        # test failed on a loaded machine.
        poller._attention[str(src.id)]["next"] = 0
        poller.wake_attention_lane()
        import time as _time

        t0 = _time.monotonic()
        while str(src.id) in poller._attention and _time.monotonic() - t0 < 5:
            await real_sleep(0.02)
        assert str(src.id) not in poller._attention


    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_source_armed_while_the_lane_waits_is_polled_at_once(self, monkeypatch):
        """The lane's whole point is sub-tick responsiveness, so arming a
        source must not wait out a nap that was scheduled before it existed.

        The loop computes how long to wait from the schedule it can see; a
        source armed a moment later is not in it. Waiting blind meant that
        source sat unpolled for up to a full clamp — longer than the cadence
        the lane advertises."""
        import time as _time

        import flow_sdk.ingest.drivers  # noqa: F401
        from flow_sdk.ingest import poller

        polled: list[str] = []

        async def _fake_run_poll(source, now):
            polled.append(str(source.id))
            poller._inflight.discard(str(source.id))

        monkeypatch.setattr(poller, "_run_poll", _fake_run_poll)
        first = await _source(provider="telegram", config={"bot_token": "t"})
        await first.request_poll_action()
        # The loop has now read the schedule and is waiting on it: the only
        # edge it knows is `first`'s next round, a full cadence away.
        await asyncio.sleep(0.2)
        assert polled == [str(first.id)], "the armed source is polled once up front"

        second = await _source(provider="telegram", config={"bot_token": "t"})
        t0 = _time.monotonic()
        await second.request_poll_action()
        while str(second.id) not in polled and _time.monotonic() - t0 < 5:
            await asyncio.sleep(0.02)

        waited = _time.monotonic() - t0
        assert str(second.id) in polled, f"never polled; waited {waited:.2f}s"
        assert waited < 1.0, (
            f"took {waited:.2f}s to poll a freshly armed source — the lane waited out a "
            "nap it scheduled before the source existed instead of being woken"
        )


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
