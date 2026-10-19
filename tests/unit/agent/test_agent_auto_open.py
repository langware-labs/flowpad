"""Agent ``auto_open`` — declared tabs, rebased onto this machine, opened by ``use()``.

Plan: ~/.claude/plans/crispy-gathering-brook.md (Part A).
"""
from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_auto_open import (
    AutoOpenTab,
    auto_open_commands,
    auto_open_prompt_block,
    open_auto_tabs,
    rebase_auto_open,
)
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.tab import Tab
from flow_sdk.schema.data_spec.dock_pointer_spec import DockPointerSpec
from tests.unit.agent._seed import seed_agent, seed_project


def _file_tab(project_id: str, rel: str) -> DockPointerSpec:
    return DockPointerSpec(viewType="project", pointer=f"{project_id}/editor/html/vfs/project-{project_id}/{rel}")


def test_a_declared_tab_must_not_name_a_machine():
    with pytest.raises(ValueError, match="machine path"):
        DockPointerSpec(viewType="project", pointer="p/editor/html/vfs/compute_node-@local/Users/x/a.html")
    with pytest.raises(ValueError):
        DockPointerSpec(viewType="no-such-view", pointer="x")


def test_rebase_names_this_machine_and_drops_what_cannot_open(tmp_path):
    (tmp_path / "report.html").write_text("<title>R</title>")
    entries = [_file_tab("P", "report.html"), _file_tab("OTHER", "report.html"),
               _file_tab("P", "missing.html"), _file_tab("P", "../escape.html")]

    tabs = rebase_auto_open(entries, roots={"P": str(tmp_path)})

    abs_sub = str((tmp_path / "report.html").resolve()).lstrip("/")
    assert [json.loads(t.pointer) for t in tabs] == [
        {"viewType": "project", "pointer": f"P/editor/html/vfs/compute_node-@local/{abs_sub}"}]
    assert tabs[0].path == (tmp_path / "report.html").resolve()


async def test_auto_open_round_trips_through_agent_json(tmp_path):
    project = await seed_project(tmp_path / "p")
    agent = await seed_agent(tmp_path / "p", "scrooge", auto_open=[_file_tab(project.id, "a.html")])

    text = (tmp_path / "p/agentic-assets/agent/scrooge/agent.json").read_text()
    assert json.loads(text)["auto_open"] == [{"viewType": "project", "pointer": agent.auto_open[0].pointer}]
    await seed_agent(tmp_path / "p", "plain")
    assert "auto_open" not in json.loads((tmp_path / "p/agentic-assets/agent/plain/agent.json").read_text())


async def test_use_opens_the_first_as_display_and_the_rest_under_the_session_tab(tmp_path):
    root = tmp_path / "p"
    project = await seed_project(root)
    for name in ("a.html", "b.html", "c.html"):
        (root / name).write_text(f"<title>{name}</title>")
    agent = await seed_agent(root, "scrooge", auto_open=[_file_tab(project.id, n) for n in ("a.html", "b.html", "c.html")])
    process = AgenticProcess(project_id=project.id, pty_mode=False)
    await process.save()

    await open_auto_tabs(process, await agent.auto_open_tabs())

    tabs = [t for t in await Tab.get_all({"project_id": project.id}) if t.visible]
    anchor = next(t for t in tabs if t.target_id == str(process.id))
    children = [t for t in tabs if t.parent_tab_id == anchor.id]
    assert sorted(json.loads(t.pointer)["pointer"].rsplit("/", 1)[-1] for t in children) == ["b.html", "c.html"]
    assert sorted(t.name for t in children) == ["b.html", "c.html"]
    shown = (await AgenticProcess.get_by_id(process.id)).context_data["last_shown"]
    assert shown["path"].endswith("/a.html")


def test_auto_open_commands_reopen_a_file_and_a_screen(tmp_path):
    report = tmp_path / "report.html"
    tabs = [AutoOpenTab(pointer=json.dumps({"viewType": "project", "pointer": "P/editor/html/x"}), path=report),
            AutoOpenTab(pointer=json.dumps({"viewType": "automations", "pointer": ""}))]

    assert auto_open_commands(tabs) == [f"flow show file {report}", "flow show view automations"]


def test_prompt_block_lists_what_opened_and_alerts_only_on_failures():
    assert auto_open_prompt_block({}) == ""
    assert auto_open_prompt_block({"auto_open_results": [{"entry": "op:x", "ok": False}]}) == ""

    block = auto_open_prompt_block({
        "auto_open": ["flow show file /p/a.html"],
        "auto_open_results": [
            {"entry": "op:serve", "ok": True, "detail": "usable"},
            {"entry": "op:dev", "ok": False, "verdict": "not_running", "detail": "connection refused"},
        ],
    })

    assert "- `flow show file /p/a.html`" in block
    assert "op:serve" not in block
    assert [line for line in block.splitlines() if line.startswith("⚠")] == [
        "⚠ op:dev did not open: connection refused — tell the user if it matters."]
