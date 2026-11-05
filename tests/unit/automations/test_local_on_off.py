"""On/off is the machine's, never the file's (docs/automations.md "On, off and recommended").

A rule that arrives in a file is indexed off and undecided; the person turns it on or off HERE
(``set_trigger_on``), the row alone is written, and no re-index or file edit moves the choice. A project
can only recommend a rule — recommended undecided rules are its setup's rows.
"""
from __future__ import annotations

import json

import pytest

from flow_sdk.builtin import trigger_arming
from flow_sdk.builtin.agent_schedule import _index
from flow_sdk.builtin.trigger import Trigger, set_trigger_on
from flow_sdk.schema.data_spec.trigger_spec import TriggerSpec

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _rule(tmp_path, body: dict):
    folder = tmp_path / "agentic-assets" / "trigger" / "rule"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "trigger.json").write_text(json.dumps({"name": "rule", "tag": {"on": "x.y"}, **body}))
    return folder


async def test_an_indexed_rule_is_undecided_and_a_choice_survives_reindex_and_file_edits(tmp_path):
    folder = _rule(tmp_path, {})
    first = await _index(folder)
    assert (first.enabled, first.decided, first.recommended) == (False, False, True)

    await set_trigger_on(first, True)
    assert "enabled" not in json.loads((folder / "trigger.json").read_text()), "the switch never goes in the file"

    _rule(tmp_path, {"tag": {"on": "x.z"}, "recommended": False})  # a pull that changes the rule
    after = await _index(folder)
    assert (after.enabled, after.decided, after.tag_pattern, after.recommended) == (True, True, "x.z", False)


def test_a_legacy_enabled_key_is_read_as_the_projects_advice():
    assert TriggerSpec.model_validate({"name": "r", "enabled": False, "tag": {"on": "x"}}).recommended is False
    assert TriggerSpec.model_validate({"name": "r", "tag": {"on": "x"}}).recommended is True


async def test_a_deployed_agent_machine_turns_recommended_rules_on(tmp_path, monkeypatch):
    monkeypatch.setattr(trigger_arming, "_deployed_agent_machine", lambda: True)
    on = await _index(_rule(tmp_path, {}))
    assert (on.enabled, on.decided) == (True, True)


async def test_recommended_undecided_rules_are_setup_rows_and_deciding_clears_them(tmp_path):
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.project_setup import _automations_here, decide_automation

    project = Project(name="p", fs_storage_mount_path=str(tmp_path))
    await project.save()
    asked = Trigger(name="asked", project_id=str(project.id), asset_ref=str(tmp_path / "a"),
                    recommended=True, enabled=False, decided=False)
    quiet = Trigger(name="quiet", project_id=str(project.id), asset_ref=str(tmp_path / "q"),
                    recommended=False, enabled=False, decided=False)
    await asked.save()
    await quiet.save()

    assert [r.name for r in await _automations_here(project)] == ["asked"]
    await decide_automation(project, str(asked.typeid), False)
    assert await _automations_here(project) == []
    row = await Trigger.get_by_id(str(asked.id))
    assert (row.enabled, row.decided) == (False, True)


async def test_a_package_is_one_setup_step_and_one_switch(tmp_path):
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.project_setup import _automations_here, decide_automation
    from flow_sdk.builtin.trigger import set_package_on

    project = Project(name="grouped", fs_storage_mount_path=str(tmp_path))
    await project.save()
    agent = Agent(name="Team code review", description="Reviews PRs.", project_id=str(project.id))
    await agent.save()

    def rule(name, parent=""):
        return Trigger(name=name, project_id=str(project.id), asset_ref=str(tmp_path / name), recommended=True,
                       enabled=False, decided=False, parent_type_id=parent or None)

    answer, pick, alone = rule("answer", str(agent.typeid)), rule("pick", str(agent.typeid)), rule("alone")
    for one in (answer, pick, alone):
        await one.save()
    await set_trigger_on(pick, False)                  # already decided: the package switch still covers it

    rows = {r.name: r for r in await _automations_here(project)}
    assert set(rows) == {"Team code review", "alone"}
    assert (rows["Team code review"].typeid, rows["Team code review"].needed_for) == (str(agent.typeid), "Reviews PRs.")

    await decide_automation(project, str(agent.typeid), True)
    assert [(await Trigger.get_by_id(str(r.id))).enabled for r in (answer, pick)] == [True, True]
    assert {r.name for r in await _automations_here(project)} == {"alone"}

    await set_package_on(str(agent.typeid), False)
    assert [(await Trigger.get_by_id(str(r.id))).enabled for r in (answer, pick)] == [False, False]
