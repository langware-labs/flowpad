"""*Check* — would it run, and what would it do — with no side effects."""

from __future__ import annotations

import pytest

from flow_sdk.automations.check import check, trigger_from_spec
from flow_sdk.automations.samples import forwarded_matching, samples_for
from flow_sdk.builtin import tag_triggers, trigger_callbacks
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction
from flow_sdk.schema.data_spec.trigger_types import TriggerType
from flow_sdk.tags import emit_tag
from flow_sdk.tags.bus import explain_subscription_match
from tests.pytest_plugin import async_context
from tests.unit.automations._helpers import history, rule, settle

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


@trigger_callbacks.register("test_check_ok")
async def _ok(trigger, changes):
    return None


OK_STEP = [TriggerAction(action_type=ActionType.CALLBACK, callback_name="test_check_ok")]


def _messages(result, area=None):
    return [f.message for f in result.findings if area is None or f.area == area]


@async_context
async def test_a_good_schedule_checks_ok_and_lists_next_runs():
    result = await check(rule(TriggerType.SCHEDULE, expr="0 9 * * 1-5", actions=OK_STEP))
    assert result.ok and len(result.next_runs) == 5
    assert result.when.schedule.preset == "weekdays"


@async_context
async def test_a_bad_schedule_says_why():
    result = await check(rule(TriggerType.SCHEDULE, expr="every tuesday", actions=OK_STEP))
    assert not result.ok and "can't be read" in _messages(result, "when")[0]


@async_context
async def test_an_event_is_matched_field_by_field():
    trigger = rule(TriggerType.TAG, tag_pattern="task.*", tag_target="task:*", actions=OK_STEP)
    hit = await check(trigger, {"tag": "task.assigned", "target": "task:t1"})
    assert hit.would_fire is True and hit.ok
    miss = await check(trigger, {"tag": "task.assigned", "target": "project:p1"})
    assert miss.would_fire is False and not miss.ok
    assert any("is not task:*" in m for m in _messages(miss, "event"))


@async_context
async def test_what_blocks_it_is_named():
    trigger = rule(TriggerType.TAG, enabled=False, fire_once=True, counter=1, actions=OK_STEP)
    messages = _messages(await check(trigger), "state")
    assert any("switched off" in m for m in messages)
    assert any("only runs once" in m for m in messages)


@async_context
async def test_steps_that_cannot_run_are_named():
    nothing = await check(rule(TriggerType.TAG))
    assert any("does nothing yet" in m for m in _messages(nothing, "then"))
    broken = await check(rule(TriggerType.TAG, actions=[
        TriggerAction(action_type=ActionType.CALLBACK, callback_name="no_such_callback")]))
    assert any("no_such_callback" in m for m in _messages(broken, "then"))
    gone = await check(rule(TriggerType.TAG, actions=[
        TriggerAction(action_type=ActionType.RUN_AGENT, target_type_id="agent-00000000-0000-4000-8000-000000000000")]))
    assert any("was not found" in m for m in _messages(gone, "then"))


@async_context
async def test_check_has_no_side_effects():
    trigger = rule(TriggerType.TAG, actions=OK_STEP)
    await trigger.save()
    await check(trigger, {"tag": "drill.x", "target": "task:1"})
    assert (await Trigger.get_by_id(trigger.id)).counter == 0
    assert history(trigger) == []


def test_an_unsaved_spec_becomes_a_trigger_and_unknown_fields_are_dropped():
    draft = trigger_from_spec({"trigger_type": "tag", "tag_pattern": "app.ready", "is_admin": True})
    assert draft.tag_pattern == "app.ready" and draft.name == "Untitled automation"


@pytest.mark.parametrize("pattern,tag,target,tfilter,expected", [
    ("app.ready", "app.ready", "x:1", None, {"tag": True, "target": True, "scope": True}),
    ("task.*", "task.assigned", "task:1", "task:*", {"tag": True, "target": True, "scope": True}),
    ("task.*", "app.ready", "task:1", None, {"tag": False, "target": True, "scope": True}),
    ("task.*", "task.done", "project:1", "task:*", {"tag": True, "target": False, "scope": True}),
])
def test_explain_matches_like_the_bus(pattern, tag, target, tfilter, expected):
    assert explain_subscription_match(pattern, tag, target, target_filter=tfilter) == expected


@async_context
async def test_an_armed_rule_remembers_its_last_matching_events():
    trigger = rule(TriggerType.TAG, tag_pattern="sample.*", actions=OK_STEP)
    await trigger.save()
    tag_triggers.register_tag_trigger(trigger)
    try:
        for i in range(7):
            emit_tag("sample.ping", f"task:{i}", {"n": i})
        await settle()
    finally:
        tag_triggers.unregister_tag_trigger(trigger.id)
    samples = samples_for(trigger)
    assert len(samples) == 5
    assert samples[0]["target"] == "task:6" and samples[0]["data"] == {"n": 6}


def test_an_unarmed_pattern_falls_back_to_the_forwarded_ring(monkeypatch):
    from flow_sdk.tags import ws_forward

    ring = [{"id": "e1", "timestamp": "t1", "tag": "task.done", "target": "task:1", "data": {}},
            {"id": "e2", "timestamp": "t2", "tag": "app.ready", "target": "x:1", "data": {}},
            {"id": "e3", "timestamp": "t3", "tag": "task.assigned", "target": "task:2", "data": {"a": 1}}]
    monkeypatch.setattr(ws_forward, "recent_events", lambda: list(ring))
    found = forwarded_matching("task.*")
    assert [s["id"] for s in found] == ["e3", "e1"]
