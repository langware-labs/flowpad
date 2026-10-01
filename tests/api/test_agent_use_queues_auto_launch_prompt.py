"""FLOWPAD-2180 — an agent's auto prompt is the first turn of EVERY local
session opened as it on request, not only the once-per-project auto-launch.

Real entities through the in-process app, entering where the UI enters: the
Use button's ``POST /agent/<id>/use`` (with the ``auto_prompt`` opt-in the UI
sends) and the loader's ``POST /api/v1/agents/auto-launch``. The assertion is
the process prompt queue (what the UI's drain kick runs), not the turn itself.
"""
from __future__ import annotations

import pytest

from flow_sdk.responses.response import ApiResponse
from tests.unit.agent._seed import seed_agent, seed_project

AUTO_LAUNCH = "/api/v1/agents/auto-launch"


async def _use(client, agent_id: str, project_id: str, **body) -> str:
    resp = await client.post(f"/api/v1/graph/agent/{agent_id}/use", json={"project_id": project_id, **body})
    assert resp.status_code == 200, resp.text
    return ApiResponse(**resp.json()).data["process_id"]


async def _queued(client, process_id: str) -> list[tuple[str, str]]:
    resp = await client.get(f"/api/v1/graph/agentic_process/{process_id}")
    return [(e["prompt"], e["source"]) for e in ApiResponse(**resp.json()).data["queue"]["entries"]]


@pytest.mark.asyncio
async def test_every_use_queues_the_agent_prompt(bootstrapped_client, tmp_path):
    project = await seed_project(tmp_path / "proj")
    agent = await seed_agent(tmp_path / "proj", "greeter", auto_launch=True, auto_launch_prompt="  Say hello  ")

    launched = ApiResponse(**(await bootstrapped_client.post(AUTO_LAUNCH, json={"project_id": project.id})).json())
    first = await _use(bootstrapped_client, agent.id, project.id, auto_prompt=True)
    second = await _use(bootstrapped_client, agent.id, project.id, auto_prompt=True)

    # Once, not twice: auto-launch must not queue it a second time on top of use().
    assert await _queued(bootstrapped_client, launched.data["process_id"]) == [("Say hello", "auto_prompt")]
    assert await _queued(bootstrapped_client, first) == [("Say hello", "auto_prompt")]
    assert await _queued(bootstrapped_client, second) == [("Say hello", "auto_prompt")]


@pytest.mark.asyncio
async def test_use_queues_without_starting_the_turn(bootstrapped_client, tmp_path, monkeypatch):
    """The UI embeds the vibe layer first and only then kicks the queue; a
    drain scheduled by ``use()`` itself would run turn 1 without that layer."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    kicks: list[str] = []
    monkeypatch.setattr(AgenticProcess, "_schedule_queue_drain", lambda self, source: kicks.append(source))
    project = await seed_project(tmp_path / "proj")
    agent = await seed_agent(tmp_path / "proj", "greeter", auto_launch_prompt="Say hello")

    process_id = await _use(bootstrapped_client, agent.id, project.id, auto_prompt=True)

    assert await _queued(bootstrapped_client, process_id) == [("Say hello", "auto_prompt")]
    assert kicks == []


@pytest.mark.asyncio
async def test_use_without_the_opt_in_opens_an_empty_session(bootstrapped_client, tmp_path):
    project = await seed_project(tmp_path / "proj")
    agent = await seed_agent(tmp_path / "proj", "greeter", auto_launch_prompt="Say hello")

    assert await _queued(bootstrapped_client, await _use(bootstrapped_client, agent.id, project.id)) == []


@pytest.mark.asyncio
async def test_an_agent_without_a_prompt_opens_an_empty_session(bootstrapped_client, tmp_path):
    project = await seed_project(tmp_path / "proj")
    agent = await seed_agent(tmp_path / "proj", "quiet", auto_launch_prompt="   ")

    process_id = await _use(bootstrapped_client, agent.id, project.id, auto_prompt=True)
    assert await _queued(bootstrapped_client, process_id) == []
