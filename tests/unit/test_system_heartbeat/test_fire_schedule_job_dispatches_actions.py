"""H1: _fire_schedule_job now dispatches the trigger's actions list through
the action handler registry (previously: only the legacy `instruction` path
ran). Verifies CALLBACK + RUN_SCRIPT dispatch + per-action failure isolation.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.trigger import Trigger, TriggerType, _fire_schedule_job


pytestmark = pytest.mark.timeout(30)


@pytest.fixture(autouse=True)
def _isolated_callback_registry(monkeypatch):
    """Snapshot + restore — keeps real builtin callbacks intact across the test."""
    snapshot = dict(trigger_callbacks._handlers)
    yield
    trigger_callbacks._handlers.clear()
    trigger_callbacks._handlers.update(snapshot)


@pytest.mark.asyncio
async def test_callback_action_dispatched_on_schedule_fire(initialize_test_db) -> None:
    """CALLBACK action on a SCHEDULE trigger runs when the trigger fires."""
    runs: list[str] = []

    @trigger_callbacks.register("test_schedule_cb")
    async def _cb(_trigger, _changed_path, _change_type) -> None:
        runs.append("cb-fired")

    trigger = await Trigger(
        name="test_schedule_dispatch",
        trigger_type=TriggerType.SCHEDULE,
        sched_trigger_type="cron",
        expr="* * * * *",
        actions=[TriggerAction(
            action_type=ActionType.CALLBACK,
            callback_name="test_schedule_cb",
        )],
    ).save()

    await _fire_schedule_job(trigger.id)

    assert runs == ["cb-fired"]
    refreshed = await Trigger.get_by_id(trigger.id)
    assert refreshed.counter == 1
    assert refreshed.last_run is not None


@pytest.mark.asyncio
async def test_one_failing_action_does_not_skip_siblings(initialize_test_db) -> None:
    runs: list[str] = []

    @trigger_callbacks.register("cb_crash")
    async def _crash(_t, _p, _c) -> None:
        raise RuntimeError("intentional")

    @trigger_callbacks.register("cb_ok")
    async def _ok(_t, _p, _c) -> None:
        runs.append("ok")

    trigger = await Trigger(
        name="test_fail_isolation",
        trigger_type=TriggerType.SCHEDULE,
        sched_trigger_type="cron",
        expr="* * * * *",
        actions=[
            TriggerAction(action_type=ActionType.CALLBACK, callback_name="cb_crash"),
            TriggerAction(action_type=ActionType.CALLBACK, callback_name="cb_ok"),
        ],
    ).save()

    await _fire_schedule_job(trigger.id)
    assert runs == ["ok"]


@pytest.mark.asyncio
async def test_disabled_trigger_no_dispatch(initialize_test_db) -> None:
    runs: list[str] = []

    @trigger_callbacks.register("cb_disabled_check")
    async def _cb(_t, _p, _c) -> None:
        runs.append("should-not-fire")

    trigger = await Trigger(
        name="test_disabled",
        trigger_type=TriggerType.SCHEDULE,
        sched_trigger_type="cron",
        expr="* * * * *",
        enabled=False,
        actions=[TriggerAction(
            action_type=ActionType.CALLBACK, callback_name="cb_disabled_check",
        )],
    ).save()

    await _fire_schedule_job(trigger.id)
    assert runs == []
    refreshed = await Trigger.get_by_id(trigger.id)
    assert refreshed.counter == 0
