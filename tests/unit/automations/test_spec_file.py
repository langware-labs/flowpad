"""Editing a file-defined automation writes its trigger.json — the row alone would be reverted."""

from __future__ import annotations

import json

import pytest

from flow_sdk.automations.spec_file import SpecFileError, apply_patch, rewrite, validate
from flow_sdk.builtin.trigger import Trigger
from tests.pytest_plugin import async_context

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

BASE = {
    "name": "Morning",
    "description": "kept",
    "schedule": {"every": "cron", "expr": "0 9 * * *"},
    "actions": [{"run_agent": {"agent": "", "prompt": "Summarize"}}],
}


def test_patch_touches_only_what_changed():
    doc = apply_patch(BASE, {"expr": "0 9 * * 1-5", "enabled": False})
    assert doc["schedule"] == {"every": "cron", "expr": "0 9 * * 1-5"}
    assert doc["enabled"] is False and doc["description"] == "kept" and doc["actions"] == BASE["actions"]


def test_row_actions_become_document_actions():
    doc = apply_patch({}, {"actions": [
        {"action_type": "run_agent", "target_type_id": "agent-1", "prompt": "Go"},
        {"action_type": "run_agent", "target_type_id": "agent-parent", "prompt": "Mine"},
        {"action_type": "run_script", "script_path": "/w/x.sh"},
        {"action_type": "callback", "callback_name": "builtin_run_wizard", "target_type_id": "wizard-9"},
        {"action_type": "callback", "callback_name": "my_step"},
    ]}, parent_type_id="agent-parent")
    assert doc["actions"] == [
        {"run_agent": {"agent": "agent-1", "prompt": "Go"}},
        {"run_agent": {"agent": "", "prompt": "Mine"}},
        {"run_script": "/w/x.sh"},
        {"run_wizard": "wizard-9"},
        {"callback": "my_step"},
    ]


def test_event_and_file_fields_map_to_their_blocks():
    doc = apply_patch({}, {"tag_pattern": "task.*", "tag_target": "task:*", "watch_path": "/w", "watch_glob": "*.md"})
    assert doc["tag"] == {"on": "task.*", "target": "task:*"}
    assert doc["watch"] == {"path": "/w", "glob": "*.md"}


def test_a_bad_schedule_is_refused_before_writing():
    with pytest.raises(SpecFileError, match="can't be read"):
        validate(apply_patch(BASE, {"expr": "nope"}))


@async_context
async def test_rewrite_writes_the_file_and_the_row_follows(tmp_path):
    from flow_sdk.builtin.agent_schedule import _index

    folder = tmp_path / "agentic-assets" / "trigger" / "morning"
    folder.mkdir(parents=True)
    (folder / "trigger.json").write_text(json.dumps(BASE))
    row = await _index(folder)

    fresh = await rewrite(row, {"expr": "30 8 * * 1-5", "name": "Weekday morning"})
    on_disk = json.loads((folder / "trigger.json").read_text())
    assert on_disk["schedule"]["expr"] == "30 8 * * 1-5" and on_disk["name"] == "Weekday morning"
    assert on_disk["description"] == "kept"
    assert fresh.id == row.id and fresh.expr == "30 8 * * 1-5"
    assert (await Trigger.get_by_id(row.id)).name == "Weekday morning"
