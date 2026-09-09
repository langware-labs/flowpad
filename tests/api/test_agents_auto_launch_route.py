"""``POST /api/v1/agents/auto-launch`` and the ``drain-queue`` process action.

Real entities through the in-process app; the only stub is ``Agent.use`` in
the route tests (the session open is covered by the agent action tests), so
the assertions stay on the route contract: payload shape, once-only, marker.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.agent import Agent, AutoLaunchOutcome
from flow_sdk.builtin.project import Project
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus
from tests.api.conftest import create_agentic_process
from tests.unit.agent._seed import seed_agent, seed_project

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

ROUTE = "/api/v1/agents/auto-launch"


@pytest.fixture
def stub_use(monkeypatch):
    """A real, saved, headless process — created without a deployment so the
    route test does not depend on compute-node placement."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    async def _use(self, project_id=None, *, deployment=None):
        proc = AgenticProcess(
            name=self.display_name, worker_type="claude_code", pty_mode=False, visible=True, project_id=project_id
        )
        await proc.save()
        return proc

    monkeypatch.setattr(Agent, "use", _use)


async def _seed(tmp_path, *names: str, prompt: str = "go") -> tuple[Project, list[Agent]]:
    project = await seed_project(tmp_path / "proj")
    agents = [
        await seed_agent(tmp_path / "proj", name, auto_launch=True, auto_launch_prompt=prompt) for name in names
    ]
    return project, agents


@pytest.mark.asyncio
async def test_project_id_is_required(bootstrapped_client):
    resp = await bootstrapped_client.post(ROUTE, json={})
    # The fail envelope, same transport contract as the journey routes.
    body = ApiResponse(**resp.json())
    assert body.status == ApiResponseStatus.FAIL.value
    assert "project_id" in (body.message or "")


@pytest.mark.asyncio
async def test_launches_once_queues_the_prompt_and_marks_the_project(bootstrapped_client, tmp_path, stub_use):
    project, agents = await _seed(tmp_path, "b-second", "a-first", prompt="Say hello")

    first = await bootstrapped_client.post(ROUTE, json={"project_id": project.id})
    assert first.status_code == 200, first.text
    data = ApiResponse(**first.json()).data
    winner = await Agent.get_by_id(data["agent_id"])
    assert winner is not None and winner.auto_launch
    assert data["process_id"] and data["process_typeid"].startswith("agentic_process-")
    assert data["prompt_queued"] is True
    assert [c["title"] for c in data["cancelled"]] == [n for n in ("a-first", "b-second") if n != winner.name]

    queue = await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{data['process_id']}")
    entries = ApiResponse(**queue.json()).data["queue"]["entries"]
    assert [(e["prompt"], e["source"]) for e in entries] == [("Say hello", "auto_launch")]

    marks = await bootstrapped_client.get(f"{ROUTE}?project_id={project.id}")
    assert set(ApiResponse(**marks.json()).data["auto_launched_agent_ids"]) == {a.id for a in agents}

    second = await bootstrapped_client.post(ROUTE, json={"project_id": project.id})
    assert ApiResponse(**second.json()).data == AutoLaunchOutcome.none_payload()


@pytest.mark.asyncio
async def test_nothing_to_launch_is_a_null_payload(bootstrapped_client, tmp_path, stub_use):
    root = tmp_path / "empty"
    root.mkdir()
    project = Project(name="empty", fs_storage_mount_path=str(root))
    await project.save()

    resp = await bootstrapped_client.post(ROUTE, json={"project_id": project.id})
    assert resp.status_code == 200, resp.text
    assert ApiResponse(**resp.json()).data == AutoLaunchOutcome.none_payload()


@pytest.mark.asyncio
async def test_drain_queue_action_is_a_prompt_less_kick(bootstrapped_client, monkeypatch):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    kicks: list[str] = []
    monkeypatch.setattr(AgenticProcess, "_schedule_queue_drain", lambda self, source: kicks.append(source))
    pid = await create_agentic_process(bootstrapped_client, pty_mode=False)
    base = f"/api/v1/graph/agentic_process/{pid}"
    await bootstrapped_client.post(f"{base}/set-queue-enabled", json={"enabled": False})
    await bootstrapped_client.post(f"{base}/enqueue", json={"prompt": "later"})

    resp = await bootstrapped_client.post(f"{base}/drain-queue")
    assert resp.status_code == 200, resp.text
    assert [e["prompt"] for e in ApiResponse(**resp.json()).data["entries"]] == ["later"]
    assert kicks[-1] == "ui"
