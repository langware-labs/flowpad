"""The compatibility boundary composes real operations, without a second dispatcher."""
from __future__ import annotations

import pytest

from flow_sdk.automations.compiler import compile_automation
from flow_sdk.automations.execution import AutomationMode, run_automation
from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction
from tests.pytest_plugin import async_context


def test_compilation_validates_then_and_keeps_one_call_per_legacy_action():
    trigger = Trigger(name="compiled", trigger_type="schedule", instruction="Also launch this.",
                      actions=[TriggerAction(action_type=ActionType.NOP)] * 2)
    spec, _ = compile_automation(trigger, mode=AutomationMode.REAL, include_instruction=True)
    assert [step.id for step in spec.steps] == ["prepare", "accept", "activate", "action_1", "action_2", "instruction"]
    assert [step.input_value for step in spec.steps if step.ref == "automation-action"] == [0, 1]
    trigger.then = {"steps": [{"id": "missing-reference"}]}
    with pytest.raises(ValueError):
        compile_automation(trigger, mode=AutomationMode.TEST)


@async_context
async def test_legacy_dispatch_continues_after_callback_failure():
    calls = []

    @trigger_callbacks.register("compiled-first-fails")
    async def first(trigger, changes):
        calls.append("first")
        raise RuntimeError("failed")

    @trigger_callbacks.register("compiled-second-refuses")
    async def second(trigger, changes):
        calls.append("second")
        return ReturnedValue.refused("disabled")

    @trigger_callbacks.register("compiled-last-runs")
    async def last(trigger, changes):
        calls.append("last")

    trigger = Trigger(name="compiled", actions=[TriggerAction(action_type=ActionType.CALLBACK, callback_name=name)
                      for name in ("compiled-first-fails", "compiled-second-refuses", "compiled-last-runs")])
    outcome = await run_automation(trigger, mode=AutomationMode.ACTIONS)
    assert calls == ["first", "second", "last"]
    assert outcome.error == "callback: failed"
    assert outcome.result.steps["action_2"].answer.exit_code is ExitCode.OK  # callbacks historically discard returns
    assert outcome.result.invocation_id == outcome.run_id
    assert all(answer.invocation_id == outcome.run_id for answer in outcome.result.steps.values())


@async_context
async def test_python_operation_exception_finalizes_accepted_tag_run(monkeypatch):
    from flow_sdk.builtin import tag_triggers
    from flow_sdk.tags.bus import make_tag_event
    from tests.unit.automations._helpers import history

    async def broken(*args, **kwargs):
        raise RuntimeError("graph unavailable")

    monkeypatch.setattr("flow_sdk.builtin.trigger.activate_flows_for_trigger", broken)
    trigger = Trigger(name="compiled-exception", trigger_type="tag", tag_pattern="test.*")
    await tag_triggers._run_tag_fire(trigger, make_tag_event("test.arrived", "trigger:test", {}),
                                    "test-event", is_test=True, run_id="test-run")
    start, done = history(trigger)
    assert start["id"] == "test-run" and start["event_id"] == done["event_id"] == "test-event"
    assert done["error"] == "graph unavailable" and done["wizard"]["exit_code"] == 1
    assert done["wizard"]["steps"]["activate"]["detail"] == "graph unavailable"


@async_context
async def test_failed_then_still_launches_legacy_instruction(monkeypatch):
    from flow_sdk.schema.data_spec.returned_value_spec import PromptResult

    launched = []

    async def launch(trigger):
        launched.append(trigger.instruction)
        return PromptResult.satisfied(executor="agentic_process-11111111-1111-4111-8111-111111111111")

    monkeypatch.setattr("flow_sdk.automations.compat.run_instruction", launch)
    trigger = Trigger(name="compiled-instruction", trigger_type="schedule", instruction="legacy prompt",
                      then={"run_script": "exit 3"})
    outcome = await run_automation(trigger, mode=AutomationMode.ACTIONS, include_instruction=True)
    assert launched == ["legacy prompt"] and outcome.result.exit_code is ExitCode.NOT_YET
    assert outcome.process_id == "11111111-1111-4111-8111-111111111111"
