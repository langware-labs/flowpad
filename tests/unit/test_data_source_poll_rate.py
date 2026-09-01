"""poll_rate: idle | active — attention-driven cadence.

Three promises pinned here, born from the "hi sat 5 minutes" incident:
the ACTIVE rate schedules at ``active_poll_interval_seconds``; a stale ACTIVE
decays back to IDLE inside ``schedule_next`` (a crashed tab can never leave a
source polling fast forever); and the activation save makes the source due
immediately WITHOUT un-latching ``config_error`` — attention never resurrects
a parked source, that stays ``poll_now``'s job.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.data_source import (
    ACTIVE_DECAY_SECONDS,
    MIN_POLL_INTERVAL_SECONDS,
    DataSource,
    PollRate,
    SourceStatus,
)
from flow_sdk.ingest.health import SourceHealth

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)


async def _source(**kw) -> DataSource:
    base = dict(provider="rss", account_key=f"acct-{uuid.uuid4().hex[:8]}", name="Feed")
    base.update(kw)
    src = DataSource(**base)
    await src.save()
    return src


class TestScheduleNext:
    def test_idle_schedules_at_the_standing_rate(self):
        src = DataSource(provider="rss", name="f", poll_interval_seconds=300)
        assert src.poll_rate == PollRate.IDLE.value
        assert src.schedule_next(NOW) == NOW + timedelta(seconds=300)

    def test_active_schedules_at_the_attention_rate(self):
        src = DataSource(
            provider="rss", name="f", poll_interval_seconds=300,
            active_poll_interval_seconds=60,
            poll_rate=PollRate.ACTIVE.value, poll_rate_set_at=NOW,
        )
        assert src.schedule_next(NOW) == NOW + timedelta(seconds=60)
        assert src.poll_rate == PollRate.ACTIVE.value, "a fresh stamp must not decay"

    def test_a_stale_active_decays_to_idle_right_here(self):
        # The safety net for a viewer that never said goodbye: the decay lives
        # in schedule_next because every caller saves right after it.
        src = DataSource(
            provider="rss", name="f", poll_interval_seconds=300,
            active_poll_interval_seconds=60,
            poll_rate=PollRate.ACTIVE.value,
            poll_rate_set_at=NOW - timedelta(seconds=ACTIVE_DECAY_SECONDS + 1),
        )
        assert src.schedule_next(NOW) == NOW + timedelta(seconds=300)
        assert src.poll_rate == PollRate.IDLE.value
        assert src.poll_rate_set_at is None

    def test_active_without_a_stamp_decays_too(self):
        # An unstampable ACTIVE (hand-written row, partial import) must not
        # poll fast forever either.
        src = DataSource(
            provider="rss", name="f", poll_interval_seconds=300,
            poll_rate=PollRate.ACTIVE.value, poll_rate_set_at=None,
        )
        src.schedule_next(NOW)
        assert src.poll_rate == PollRate.IDLE.value


class TestSaveTransitions:
    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_activation_stamps_and_makes_due(self):
        src = await _source()
        src.schedule_next(NOW)  # a schedule minutes out must not delay attention
        src.poll_rate = PollRate.ACTIVE.value
        await src.save()
        assert src.poll_rate_set_at is not None
        assert src.next_poll_at is None, "activation means: poll on the next tick"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_second_active_save_does_not_re_make_due(self):
        # The poller itself saves once a minute while active; if that looked
        # like a fresh activation the schedule arithmetic would never stand.
        src = await _source(poll_rate=PollRate.ACTIVE.value)
        assert src.poll_rate_set_at is not None
        scheduled = src.schedule_next(NOW)
        await src.save()
        assert src.next_poll_at == scheduled
        assert src.poll_rate_set_at is not None

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_going_idle_clears_the_stamp_and_keeps_the_schedule(self):
        src = await _source(poll_rate=PollRate.ACTIVE.value)
        scheduled = src.schedule_next(NOW)
        src.poll_rate = PollRate.IDLE.value
        await src.save()
        assert src.poll_rate_set_at is None
        assert src.next_poll_at == scheduled, "idle is not urgent; the schedule stands"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_client_round_tripped_stale_stamp_cannot_suppress_activation(self):
        # The live bug this pins: the frontend PUTs the WHOLE entity, so a
        # re-activation arrives carrying the stamp of a PREVIOUS activation.
        # The stamp is server-owned — the diff is against the DB row, never
        # against what the payload claims — so the fresh activation must
        # re-stamp and make the source due regardless.
        src = await _source(poll_rate=PollRate.ACTIVE.value)
        stale_stamp = src.poll_rate_set_at
        src.poll_rate = PollRate.IDLE.value
        await src.save()  # deselected: DB now idle, stamp cleared

        replayed = await DataSource.get_by_id(src.id)
        replayed.poll_rate = PollRate.ACTIVE.value
        replayed.poll_rate_set_at = stale_stamp  # the client's stale copy
        replayed.next_poll_at = NOW + timedelta(seconds=300)
        await replayed.save()

        assert replayed.poll_rate_set_at is not None
        assert replayed.poll_rate_set_at != stale_stamp, "activation must re-stamp"
        assert replayed.next_poll_at is None, "activation must poll on the next tick"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_attention_never_resurrects_a_parked_source(self):
        # poll_now un-latches config_error on purpose; activation must NOT —
        # a human decision (or a broken credential) outranks a mounted view.
        src = await _source()
        src.health = SourceHealth.CONFIG_ERROR.value
        await src.save()
        src.poll_rate = PollRate.ACTIVE.value
        await src.save()
        assert src.health == SourceHealth.CONFIG_ERROR.value
        assert src.is_due(NOW) is False

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_disabled_source_stays_asleep_at_any_rate(self):
        src = await _source(status=SourceStatus.DISABLED.value, poll_rate=PollRate.ACTIVE.value)
        assert src.is_due(NOW) is False


class TestFloor:
    def test_the_attention_rate_cannot_undercut_the_heartbeat(self):
        with pytest.raises(ValidationError):
            DataSource(
                provider="rss", name="f",
                active_poll_interval_seconds=MIN_POLL_INTERVAL_SECONDS - 1,
            )
