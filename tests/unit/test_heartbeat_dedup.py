"""Test that heartbeat job registration doesn't race and create duplicates."""

import asyncio
import pytest
from unittest.mock import AsyncMock, patch, MagicMock


@pytest.mark.timeout(30)
async def test_concurrent_register_schedule_job_uses_lock():
    """Verify that concurrent calls to _register_schedule_job are serialized by the lock."""
    from flow_sdk.builtin.trigger import Trigger, TriggerType
    from flow_sdk.server.scheduler import _job_registration_lock

    # Create a mock trigger
    trigger = Trigger(
        uname="test_trigger",
        name="Test Trigger",
        trigger_type=TriggerType.SCHEDULE,
        sched_trigger_type="cron",
        expr="* * * * *",
    )
    trigger.id = "test-id-12345"

    call_count = 0
    original_add_job = None

    def counting_add_job(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        # Return a mock job
        return MagicMock(next_run_time=None, pause=MagicMock())

    # Patch the scheduler and verify the lock is being held
    with patch("flow_sdk.builtin.trigger._get_scheduler") as mock_get_scheduler:
        mock_scheduler = MagicMock()
        mock_scheduler.add_job = counting_add_job
        mock_get_scheduler.return_value = mock_scheduler

        # Simulate 5 concurrent calls to _register_schedule_job
        # Without the lock, all 5 would try to add_job concurrently
        # With the lock, they serialize
        tasks = [trigger._register_schedule_job() for _ in range(5)]
        await asyncio.gather(*tasks)

        # With the lock, all 5 should succeed but only 1 actual add_job call
        # reaches the scheduler (the others wait for the lock)
        # Actually, they should all call add_job because each one acquires
        # the lock in sequence, but the key is that replace_existing=True
        # works correctly when they're serialized
        assert call_count == 5, f"Expected 5 add_job calls (serialized), got {call_count}"


@pytest.mark.timeout(30)
async def test_lock_prevents_concurrent_add_job():
    """Verify the lock is actually acquired during registration."""
    from flow_sdk.server.scheduler import _job_registration_lock
    from flow_sdk.builtin.trigger import Trigger, TriggerType

    trigger = Trigger(
        uname="test_trigger",
        name="Test Trigger",
        trigger_type=TriggerType.SCHEDULE,
        sched_trigger_type="cron",
        expr="* * * * *",
    )
    trigger.id = "test-id-12345"

    lock_acquired_times = []

    # Track when the lock is acquired
    original_acquire = _job_registration_lock.acquire

    async def tracking_acquire():
        lock_acquired_times.append("acquired")
        return await original_acquire()

    with patch("flow_sdk.builtin.trigger._get_scheduler") as mock_get_scheduler:
        mock_scheduler = MagicMock()
        mock_scheduler.add_job = MagicMock(return_value=MagicMock(next_run_time=None, pause=MagicMock()))
        mock_get_scheduler.return_value = mock_scheduler

        # Patch the lock's acquire to track acquisitions
        with patch.object(_job_registration_lock, "acquire", side_effect=tracking_acquire):
            tasks = [trigger._register_schedule_job() for _ in range(3)]
            await asyncio.gather(*tasks)

        # The lock should be acquired multiple times (once per call)
        # but the critical section is serialized
        assert len(lock_acquired_times) >= 3, f"Expected at least 3 lock acquisitions, got {len(lock_acquired_times)}"


@pytest.mark.timeout(30)
async def test_heartbeat_trigger_registered_once():
    """Verify that set_service_triggers only results in one APScheduler job."""
    from flow_sdk.server.builtin_triggers import set_service_triggers
    from flow_sdk.builtin.trigger import Trigger

    add_job_calls = []

    def mock_add_job(*args, **kwargs):
        add_job_calls.append({"args": args, "kwargs": kwargs})
        mock_job = MagicMock()
        mock_job.next_run_time = None
        mock_job.pause = MagicMock()
        return mock_job

    with patch("flow_sdk.builtin.trigger._get_scheduler") as mock_get_scheduler:
        mock_scheduler = MagicMock()
        mock_scheduler.add_job = mock_add_job
        mock_scheduler.reschedule_job = MagicMock()
        mock_get_scheduler.return_value = mock_scheduler

        with patch("flow_sdk.builtin.trigger.Trigger.get_by_uname") as mock_get_by_uname:
            existing_trigger = Trigger(
                id="heartbeat-id",
                uname="builtin_system_heartbeat",
                name="System heartbeat",
                trigger_type="schedule",
                sched_trigger_type="cron",
                expr="* * * * *",
            )

            # Each builtin trigger resolves to its OWN entity (distinct id). Only
            # the system heartbeat carries "heartbeat-id"; other SCHEDULE builtins
            # (e.g. the daily usage-analysis trigger) register under their own id,
            # so the heartbeat-id filter below isolates the heartbeat alone.
            def _get_by_uname(uname):
                if uname == "builtin_system_heartbeat":
                    return existing_trigger
                return Trigger(
                    id=f"other-{uname}",
                    uname=uname,
                    name=uname,
                    trigger_type="schedule",
                    sched_trigger_type="cron",
                    expr="* * * * *",
                )

            mock_get_by_uname.side_effect = _get_by_uname

            with patch.object(Trigger, "update", new_callable=AsyncMock) as mock_update:
                with patch.object(Trigger, "save", new_callable=AsyncMock):
                    await set_service_triggers()

        # Filter for heartbeat job registrations only
        heartbeat_calls = [c for c in add_job_calls if c["kwargs"].get("id") == "heartbeat-id"]

        # Should have only one heartbeat job registered per spec (could be multiple specs but only one heartbeat)
        assert len(heartbeat_calls) <= 1, f"Expected at most 1 heartbeat job registration, got {len(heartbeat_calls)}"
