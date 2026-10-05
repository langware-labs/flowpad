"""Every real fire leaves a row a person can navigate: the run it started, the error, the cause."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.automations.fingerprint import spec_hash
from flow_sdk.builtin import agent_run, tag_triggers, trigger_callbacks
from flow_sdk.builtin.change_event import ChangeEvent
from flow_sdk.builtin.trigger_hook_bridge import _log_hook_fire
from flow_sdk.fs_store.operations.trigger_log import CAUSE_DATA_MAX_CHARS, cap_cause_data
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction
from flow_sdk.schema.data_spec.trigger_types import TriggerType
from flow_sdk.server.fsop_watcher import _fire
from flow_sdk.tags import emit_tag
from tests.pytest_plugin import async_context
from tests.unit.automations._helpers import history, rule, settle

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

ANSWER = SimpleNamespace(marker="started-an-agent")


@trigger_callbacks.register("test_log_keys_starts_agent")
async def _starts_agent(trigger, changes):
    return ANSWER


@trigger_callbacks.register("test_log_keys_fails")
async def _fails(trigger, changes):
    raise RuntimeError("quota exhausted")


def _calls(name: str) -> list[TriggerAction]:
    return [TriggerAction(action_type=ActionType.CALLBACK, callback_name=name)]


@pytest.fixture
def agent_answers(monkeypatch):
    """The callback handler drops return values; a RUN_AGENT handler returns the run.
    Stand one in at the seam the outcome reads, so the pid capture is exercised."""
    from flow_sdk.builtin import hook_models

    class _RunAgentLike:
        async def execute(self, trigger, action=None, changes=None):
            return await _starts_agent(trigger, changes)

    real = hook_models.get_action_handler
    monkeypatch.setattr(
        "flow_sdk.builtin.trigger.get_action_handler",
        lambda t: _RunAgentLike() if t == ActionType.RUN_AGENT else real(t),
    )
    monkeypatch.setattr(agent_run, "process_id_of", lambda a: "proc-123" if a is ANSWER else None)


def test_cause_data_is_capped():
    assert cap_cause_data({"path": "a.md"}) == {"path": "a.md"}
    long = cap_cause_data({"blob": "x" * 2000})
    assert len(long["_excerpt"]) == CAUSE_DATA_MAX_CHARS and long["_cut"] > 0
    assert cap_cause_data(None) is None


@async_context
async def test_real_event_fire_writes_start_and_done_rows(agent_answers):
    trigger = rule(TriggerType.TAG, tag_pattern="logkeys.*",
                   actions=[TriggerAction(action_type=ActionType.RUN_AGENT)])
    await trigger.save()
    tag_triggers.register_tag_trigger(trigger)
    try:
        emit_tag("logkeys.ping", "task:t-1", {"title": "hello"})
        await settle()
    finally:
        tag_triggers.unregister_tag_trigger(trigger.id)
    start, done = history(trigger)
    assert start["hook_event"] == "tag_fire" and not start["is_test"]
    assert start["cause_data"] == {"title": "hello"}
    assert done["hook_event"] == "tag_fire_done" and done["event_id"] == start["event_id"]
    assert done["agentic_process_id"] == "proc-123"
    assert done["spec_hash"] == spec_hash(trigger)


@async_context
async def test_real_event_fire_records_the_error():
    trigger = rule(TriggerType.TAG, tag_pattern="logfail.*", actions=_calls("test_log_keys_fails"))
    await trigger.save()
    tag_triggers.register_tag_trigger(trigger)
    try:
        emit_tag("logfail.ping", "task:t-1")
        await settle()
    finally:
        tag_triggers.unregister_tag_trigger(trigger.id)
    assert "quota exhausted" in history(trigger)[-1]["error"]


@async_context
async def test_file_fire_records_the_run_it_started(agent_answers, tmp_path):
    trigger = rule(TriggerType.FSOP, watch_path=str(tmp_path),
                   actions=[TriggerAction(action_type=ActionType.RUN_AGENT)])
    await trigger.save()
    await _fire(trigger, [ChangeEvent(path=tmp_path / "a.md", change_type="modified")])
    (row,) = history(trigger)
    assert row["agentic_process_id"] == "proc-123"
    assert row["error"] is None and isinstance(row["duration_ms"], int)


def test_matched_hook_fire_writes_a_row():
    from flow_sdk.builtin.hook_models import HookEventData

    trigger = rule(TriggerType.HOOK)
    trigger.id = "hook-rule-1"
    _log_hook_fire(trigger, HookEventData(hook_event_name="PostToolUse"), "evt-1", "sess-1")
    (row,) = history(trigger)
    assert row["hook_event"] == "hook_fire" and row["event_kind"] == "PostToolUse"
    assert row["trigger_id"] == "hook-rule-1" and row["event_id"] == "evt-1"
    assert row["cause_data"]["session_id"] == "sess-1"


def test_log_appends_in_place_and_still_caps(monkeypatch):
    from flow_sdk.fs_store.operations import trigger_log

    monkeypatch.setattr(trigger_log, "MAX_ENTRIES", 10)
    monkeypatch.setattr(trigger_log, "DROP_COUNT", 4)
    for i in range(14):
        trigger_log.append_entry("cap-rule", {"reason": str(i)})
    rows = trigger_log.discover("cap-rule", limit=100)
    # 10 rows, then a trim to 6 + 1, then 3 more appends.
    assert [r["reason"] for r in rows][::-1] == [str(i) for i in range(4, 14)]


def test_row_index_groups_like_rows_for():
    from flow_sdk.automations.runs import RowIndex, rows_for

    rows = [{"id": "a", "ts": "3", "trigger_id": "t1"}, {"id": "b", "ts": "2", "trigger_id": "t2"},
            {"id": "c", "ts": "1", "rule_name": "Morning"}]
    assert [r["id"] for r in RowIndex(rows).rows_for("t1", "Morning")] == [r["id"] for r in rows_for("t1", "Morning", rows)]
