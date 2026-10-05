"""The Automations list: a sentence per rule, its group, its health, and "Not tested yet"."""

from __future__ import annotations

import pytest

from flow_sdk.automations.describe import describe_then, describe_when
from flow_sdk.automations.overview import group_of, overview
from flow_sdk.automations.run_once import run_once
from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction
from flow_sdk.schema.data_spec.trigger_types import TriggerType
from tests.pytest_plugin import async_context
from tests.unit.automations._helpers import rule, settle

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


@trigger_callbacks.register("test_overview_noop")
async def _noop(trigger, changes):
    return None


def _noop_action():
    return [TriggerAction(action_type=ActionType.CALLBACK, callback_name="test_overview_noop")]


def test_when_reads_each_kind(tmp_path):
    assert describe_when(rule(TriggerType.SCHEDULE, expr="0 9 * * 1-5")).text == "Every weekday at 09:00"
    event = describe_when(rule(TriggerType.TAG, tag_pattern="app.ready"))
    assert event.kind == "event" and event.event.title and event.text == f"When {event.event.title} happens"
    file = describe_when(rule(TriggerType.FSOP, watch_path=str(tmp_path), watch_glob="*.md"))
    assert file.kind == "file" and file.text == f"When *.md in {tmp_path} changes"
    hook = describe_when(rule(TriggerType.HOOK, hook_events=["Stop"]))
    assert hook.kind == "agent_hook" and hook.hook.events == ["Stop"]


@async_context
async def test_then_names_the_step_and_flags_a_broken_one():
    parts = await describe_then(rule(TriggerType.TAG, actions=[
        *_noop_action(),
        TriggerAction(action_type=ActionType.CALLBACK, callback_name="nobody_registered_this"),
        TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path="/w/scripts/sync.py"),
    ]))
    assert [p.kind for p in parts] == ["builtin_step", "builtin_step", "run_script"]
    assert parts[0].problem is None and "nobody_registered_this" in parts[1].problem
    assert parts[2].text == "Run script sync.py"


@async_context
async def test_a_rule_with_no_steps_says_so():
    (part,) = await describe_then(rule(TriggerType.TAG))
    assert part.kind == "nothing"


def test_groups():
    assert group_of(rule(TriggerType.TAG, scope="system")) == "builtin"
    assert group_of(rule(TriggerType.TAG, uname="builtin_x")) == "builtin"
    assert group_of(rule(TriggerType.TAG, project_id="p1")) == "project"
    assert group_of(rule(TriggerType.TAG)) == "mine"


async def _summary(trigger: Trigger):
    rows = await overview()
    return next(s for s in rows if s.id == trigger.id)


@async_context
async def test_a_new_rule_is_not_tested_and_a_test_run_clears_it():
    trigger = rule(TriggerType.TAG, actions=_noop_action())
    await trigger.save()
    assert (await _summary(trigger)).tested is False

    await run_once(trigger)
    await settle()
    summary = await _summary(trigger)
    assert summary.tested is True
    assert summary.last_run is not None and summary.last_run.is_test


@async_context
async def test_editing_the_rule_untests_it_and_switching_off_does_not():
    trigger = rule(TriggerType.TAG, actions=_noop_action())
    await trigger.save()
    await run_once(trigger)
    await settle()

    trigger.enabled = False
    await trigger.update()
    assert (await _summary(trigger)).tested is True

    trigger.tag_pattern = "drill.other.*"
    await trigger.update()
    assert (await _summary(trigger)).tested is False


@async_context
async def test_failures_are_counted_over_recent_real_runs():
    @trigger_callbacks.register("test_overview_fails")
    async def _fails(trigger, changes):
        raise RuntimeError("nope")

    from flow_sdk.builtin import tag_triggers
    from flow_sdk.tags import emit_tag

    trigger = rule(TriggerType.TAG, tag_pattern="ovfail.*",
                   actions=[TriggerAction(action_type=ActionType.CALLBACK, callback_name="test_overview_fails")])
    await trigger.save()
    tag_triggers.register_tag_trigger(trigger)
    try:
        emit_tag("ovfail.a", "task:1")
        await settle()
        emit_tag("ovfail.b", "task:1")
        await settle()
    finally:
        tag_triggers.unregister_tag_trigger(trigger.id)
    summary = await _summary(trigger)
    assert (summary.recent_failures, summary.recent_runs) == (2, 2)
    assert summary.last_run.status == "failed" and "nope" in summary.last_run.error


@async_context
async def test_a_builtin_step_says_what_it_does():
    @trigger_callbacks.register("test_overview_described", meaning="Re-reads the toplog filter and tells the UI.")
    async def _described(trigger, changes):
        return None

    (part,) = await describe_then(rule(TriggerType.TAG, actions=[
        TriggerAction(action_type=ActionType.CALLBACK, callback_name="test_overview_described")]))
    assert part.kind == "builtin_step" and part.detail == "Re-reads the toplog filter and tells the UI."


def test_a_watched_folder_is_marked_browsable(tmp_path):
    folder = describe_when(rule(TriggerType.FSOP, watch_path=str(tmp_path)))
    one_file = describe_when(rule(TriggerType.FSOP, watch_path=str(tmp_path / "a.json")))
    assert folder.file.is_folder is True and one_file.file.is_folder is False
