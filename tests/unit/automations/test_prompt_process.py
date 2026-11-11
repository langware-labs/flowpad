"""A callback into a session: linked both ways, delivered through the session's queue, gone with it —
and a one-shot whose time passed while nothing could run it still runs, once."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.hook_models import PromptProcessActionHandler, callback_text
import flow_sdk.builtin.trigger as trigger_module
from flow_sdk.builtin.trigger import Trigger, pending_callbacks, run_schedule_fire
from flow_sdk.request_context import detached
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction
from flow_sdk.schema.data_spec.trigger_types import TriggerType
from tests.pytest_plugin import async_context
from tests.unit.automations._helpers import rule

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

FIRED: list[str] = []


@trigger_callbacks.register("test_one_shot_record")
async def _record(trigger, changes):
    FIRED.append(trigger.id)


def _at(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) + delta).isoformat(timespec="seconds")


async def _session() -> AgenticProcess:
    """A headless session whose queue is paused: a delivery is kept, never run."""
    process = AgenticProcess(name="chat", pty_mode=False, visible=False)
    await process.save()
    process.queue.set_enabled(False)
    return process


async def _callback(process: AgenticProcess, prompt: str = "check the deploy") -> Trigger:
    trigger = rule(TriggerType.SCHEDULE, sched_trigger_type="date", expr=_at(timedelta(days=1)), actions=[
        TriggerAction(action_type=ActionType.PROMPT_PROCESS, target_type_id=str(process.typeid), prompt=prompt)])
    assert await trigger.bind_callback() is None
    await trigger.save()
    await trigger.link_process()
    return trigger


@async_context
async def test_callback_and_session_know_each_other_until_it_is_removed():
    process = await _session()
    trigger = await _callback(process)

    process = await AgenticProcess.get_by_id(process.id)
    assert trigger.typeid in process.private_context_entities
    assert process.typeid in (await Trigger.get_by_id(trigger.id)).private_context_entities
    assert [t.id for t in await pending_callbacks(process)] == [trigger.id]

    await trigger.delete()
    assert trigger.typeid not in (await AgenticProcess.get_by_id(process.id)).private_context_entities


@async_context
async def test_fire_queues_the_callback_line_for_the_session():
    process = await _session()
    trigger = await _callback(process)

    await run_schedule_fire(trigger, None, is_test=False)

    assert [e["prompt"] for e in process.queue.read()["entries"]] == [callback_text(trigger.id, "check the deploy")]
    line = callback_text(trigger.id, "x\ny")
    assert line.startswith(f"This is trigger {trigger.id} callback: x y ") and "\n" not in line
    assert await pending_callbacks(await AgenticProcess.get_by_id(process.id)) == []  # fired: no longer waiting


@async_context
async def test_a_session_that_is_gone_is_not_found():
    action = TriggerAction(action_type=ActionType.PROMPT_PROCESS, prompt="p",
                           target_type_id="agentic_process-7f0c0000-0000-4000-8000-000000000000")
    answer = await PromptProcessActionHandler().execute(rule(TriggerType.SCHEDULE), action)
    assert answer.exit_code == ExitCode.NOT_FOUND


@async_context
async def test_a_callback_must_be_a_one_shot_on_a_real_session_under_the_cap(monkeypatch):
    monkeypatch.setattr(trigger_module, "MAX_PENDING_CALLBACKS", 2)
    process = await _session()
    recurring = rule(TriggerType.SCHEDULE, actions=[
        TriggerAction(action_type=ActionType.PROMPT_PROCESS, target_type_id=str(process.typeid), prompt="p")])
    assert "once" in await recurring.bind_callback()
    for _ in range(2):
        await _callback(process)
        process = await AgenticProcess.get_by_id(process.id)
    extra = rule(TriggerType.SCHEDULE, sched_trigger_type="date", expr=_at(timedelta(days=1)), actions=[
        TriggerAction(action_type=ActionType.PROMPT_PROCESS, target_type_id=str(process.typeid), prompt="p")])
    assert "waiting" in await extra.bind_callback()


@async_context
async def test_deleting_the_session_removes_its_waiting_callbacks():
    process = await _session()
    trigger = await _callback(process)

    await AgenticProcess.delete_by_id(process.id)  # the HTTP delete route

    assert await Trigger.get_by_id(trigger.id) is None


@async_context
async def test_an_overdue_one_shot_runs_once_when_armed():
    trigger = rule(TriggerType.SCHEDULE, sched_trigger_type="date", expr=_at(timedelta(hours=-3)), actions=[
        TriggerAction(action_type=ActionType.CALLBACK, callback_name="test_one_shot_record")])
    await trigger.save()
    assert trigger._overdue_one_shot()
    assert not rule(TriggerType.SCHEDULE, sched_trigger_type="date", expr=_at(timedelta(hours=3)))._overdue_one_shot()

    await trigger._register_schedule_job()
    await trigger._register_schedule_job()  # a re-index while the first fire is in flight
    await asyncio.gather(*list(detached._DETACHED))
    await (await Trigger.get_by_id(trigger.id))._register_schedule_job()  # and one after it
    await asyncio.gather(*list(detached._DETACHED))

    assert FIRED.count(trigger.id) == 1
