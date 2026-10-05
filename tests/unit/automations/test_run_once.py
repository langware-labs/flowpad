"""*Run once now* — one rule for every kind: runs when off, spends nothing, logs is_test."""

from __future__ import annotations

import pytest

from flow_sdk.automations.fingerprint import spec_hash
from flow_sdk.automations.run_once import RunOnceRefused, run_once, sample_tag
from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction
from flow_sdk.schema.data_spec.trigger_types import TriggerType
from tests.pytest_plugin import async_context
from tests.unit.automations._helpers import history, rule, settle

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

CALLS: list[str] = []


@trigger_callbacks.register("test_automation_record_call")
async def _record(trigger, changes):
    CALLS.append(trigger.name)


@trigger_callbacks.register("test_automation_boom")
async def _boom(trigger, changes):
    raise RuntimeError("the agent is not set up")


def _calls(name: str) -> list[TriggerAction]:
    return [TriggerAction(action_type=ActionType.CALLBACK, callback_name=name)]


def test_sample_tag_fills_wildcards():
    assert sample_tag("drill.*") == "drill.test"
    assert sample_tag("app.tab.ready") == "app.tab.ready"


@async_context
async def test_event_rule_runs_when_off_and_spends_nothing():
    trigger = rule(TriggerType.TAG, enabled=False, fire_once=True,
                   actions=_calls("test_automation_record_call"))
    await trigger.save()
    started = await run_once(trigger)
    await settle()

    assert started.event_id and started.background
    assert trigger.name in CALLS
    row = await Trigger.get_by_id(trigger.id)
    assert row.counter == 0  # fire_once stays unspent
    start, done = history(trigger)
    assert (start["hook_event"], done["hook_event"]) == ("tag_fire", "tag_fire_done")
    assert start["event_id"] == done["event_id"] == started.event_id
    assert start["is_test"] and done["is_test"]
    assert done["spec_hash"] == spec_hash(trigger)
    assert done["error"] is None and isinstance(done["duration_ms"], int)


@async_context
async def test_event_rule_runs_with_the_picked_event():
    trigger = rule(TriggerType.TAG, actions=_calls("test_automation_record_call"))
    await trigger.save()
    await run_once(trigger, {"tag": "drill.pick", "target": "task:t-1", "data": {"title": "Fix it"}})
    await settle()
    start = history(trigger)[0]
    assert (start["cause_tag"], start["cause_target"]) == ("drill.pick", "task:t-1")
    assert start["cause_data"] == {"title": "Fix it"}


@async_context
async def test_failing_action_is_recorded_on_the_run():
    trigger = rule(TriggerType.TAG, actions=_calls("test_automation_boom"))
    await trigger.save()
    await run_once(trigger)
    await settle()
    done = history(trigger)[-1]
    assert "the agent is not set up" in done["error"]


@async_context
async def test_schedule_runs_when_off_without_a_counter_bump():
    trigger = rule(TriggerType.SCHEDULE, enabled=False, actions=_calls("test_automation_record_call"))
    await trigger.save()
    await run_once(trigger)
    await settle()
    assert trigger.name in CALLS
    assert (await Trigger.get_by_id(trigger.id)).counter == 0
    (row,) = history(trigger)
    assert row["hook_event"] == "schedule_fire" and row["is_test"] is True
    assert row["spec_hash"] == spec_hash(trigger)


@async_context
async def test_file_rule_runs_when_off(tmp_path):
    trigger = rule(TriggerType.FSOP, enabled=False, watch_path=str(tmp_path),
                   actions=_calls("test_automation_record_call"))
    await trigger.save()
    await run_once(trigger)
    await settle()
    (row,) = history(trigger)
    assert row["is_test"] is True and row["event_kind"] == "test"
    assert (await Trigger.get_by_id(trigger.id)).counter == 0


@async_context
async def test_refusals_say_what_to_fix(tmp_path):
    with pytest.raises(RunOnceRefused, match="no event"):
        await run_once(rule(TriggerType.TAG, tag_pattern=None))
    with pytest.raises(RunOnceRefused, match="watches no file"):
        await run_once(rule(TriggerType.FSOP, watch_path=None))
    with pytest.raises(RunOnceRefused, match="no rule folder"):
        await run_once(rule(TriggerType.HOOK, path=None))
