"""An agent's ``auto_open`` tabs open with every local session opened as it —
through the real routes the UI enters by: auto-launch and the Use button.

Asserted where the frontend reads them: the session's ``last_shown`` (its active
display) and the tab list (the rest, under the session's own tab).
"""
from __future__ import annotations

import json

import pytest

from flow_sdk.responses.response import ApiResponse
from flow_sdk.schema.data_spec.dock_pointer_spec import DockPointerSpec
from tests.unit.agent._seed import seed_agent, seed_project


async def _data(resp):
    assert resp.status_code == 200, resp.text
    return ApiResponse(**resp.json()).data


@pytest.mark.asyncio
async def test_auto_launch_and_use_open_the_declared_tabs(bootstrapped_client, tmp_path):
    root = tmp_path / "proj"
    project = await seed_project(root)
    (root / "scoreboard.html").write_text("<title>GTM Scoreboard</title>")
    (root / "week.html").write_text("<title>Week</title>")
    tabs = [DockPointerSpec(viewType="project", pointer=f"{project.id}/editor/html/vfs/project-{project.id}/{n}")
            for n in ("scoreboard.html", "week.html")]
    agent = await seed_agent(root, "scrooge", auto_launch=True, auto_open=tabs)

    launched = await _data(await bootstrapped_client.post("/api/v1/agents/auto-launch", json={"project_id": project.id}))
    used = await _data(await bootstrapped_client.post(f"/api/v1/graph/agent/{agent.id}/use", json={"project_id": project.id}))

    listed = (await _data(await bootstrapped_client.get("/api/v1/graph/tab/list", params={"project": project.id})))["tabs"]
    for process_id in (launched["process_id"], used["process_id"]):
        process = await _data(await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{process_id}"))
        assert process["context_data"]["last_shown"]["path"].endswith("/scoreboard.html")
    # A tab IS its address — one file, one tab on this machine — so the week tab
    # sits under the session that opened it last, not one copy per session.
    anchor = next(t for t in listed if t.get("target_id") == used["process_id"])
    children = [json.loads(t["pointer"])["pointer"] for t in listed if t.get("parent_tab_id") == anchor["id"]]
    assert [c.rsplit("/", 1)[-1] for c in children] == ["week.html"]
