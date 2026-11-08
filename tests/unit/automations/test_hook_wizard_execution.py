"""Callable hook delivery executes a real wizard without changing the hook wire answer."""

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.hook_models import HookEventData
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]


async def test_callable_hook_runs_a_wizard_and_keeps_its_wire_shape(initialize_test_db):
    name = f"hook-wizard-{mint_uuid()}"
    called = []

    @trigger_callbacks.register(name)
    async def effect(trigger, changes):
        called.append((trigger.id, changes))

    trigger = await Trigger(
        name=name, trigger_type="hook", mask={"hook_event_name": "UserPromptSubmit"},
        actions=[TriggerAction(action_type=ActionType.CALLBACK, callback_name=name)],
    ).save()
    try:
        assert await trigger.invoke(HookEventData(hook_event_name="Stop")) is None
        answer = await trigger.invoke(HookEventData(hook_event_name="UserPromptSubmit"))
        assert called == [(trigger.id, [])]
        assert set(answer.model_dump()) == {"trigger_id", "trigger_name", "action_type", "counter"}
        execution = answer._execution
        assert execution.result.invocation_id == execution.run_id
        assert execution.result.steps and execution.error is None
        assert (await Trigger.get_by_id(trigger.id)).last_triggered is not None
    finally:
        trigger_callbacks._handlers.pop(name, None)


async def test_removed_rule_engine_returns_an_explanatory_refusal(tmp_path):
    from flow_sdk.automations.run_once import RunOnceRefused, _run_hook_rule_once

    (tmp_path / "record.json").write_text("{}")
    trigger = Trigger(name="removed-rule", trigger_type="hook", path=str(tmp_path))
    with pytest.raises(RunOnceRefused, match="removed ActivationRule"):
        await _run_hook_rule_once(trigger)
