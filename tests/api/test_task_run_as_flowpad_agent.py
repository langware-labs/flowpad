"""A task owned by staff that is a Flowpad agent runs as that agent (FLOWPAD-2261).

``subagent:<name>`` names a ``.claude/agents`` file; when the creator's project also holds a Flowpad
agent of that name, the run gets that agent's worker, options, system prompt and MCP servers — not
the creator's options and a bare prompt — and it belongs to no placement. Driven as a chief does it:
``flow task create`` from the chief's worker, the task runtime dispatching the run.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.mcp import Mcp
from flow_sdk.builtin.task import Task
from flow_sdk.tasks import runtime
from tests.utils.mock_behaviors import flow_runner
from tests.utils.mock_worker import mock_driver_for

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture
async def project(tmp_path, bootstrapped_client):
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    root = tmp_path / "proj"
    root.mkdir()
    return await Project(id=mint_uuid(), name=f"staff-{mint_uuid()[:8]}", fs_storage_mount_path=str(root)).save()


async def test_a_task_the_cli_hands_to_a_flowpad_agent_runs_with_its_mcp_servers_and_options(
        project, bootstrapped_client, monkeypatch, tmp_path):
    driver = mock_driver_for("claude", tmp_path / "transcripts", behavior=lambda _turn: "on it")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: driver)

    name = f"qa-tester-{uuid.uuid4().hex[:6]}"
    staff_dir = Path(project.fs_storage_mount_path) / ".claude" / "agents"
    staff_dir.mkdir(parents=True)
    (staff_dir / f"{name}.md").write_text(f"---\nname: {name}\ndescription: runs QA\n---\nYou run QA cycles.\n",
                                          encoding="utf-8")
    qa_mcp = await Mcp(name=f"qa_mcp_{uuid.uuid4().hex[:6]}", command="/bin/true").save(notify=False)
    staff = await Agent(name=name, worker_type="claude", model="opus", system_prompt="You are the QA tester.",
                        mcp_servers=[str(qa_mcp.typeid)], project_id=project.id).save()
    chief = await Agent(name=f"chief-{uuid.uuid4().hex[:6]}", worker_type="claude", model="haiku",
                        chief_of_staff=True, project_id=project.id).save()
    worker = await (await chief.local_deployment()).create_process(
        "", target_typeid_str=f"conversation-{uuid.uuid4()}", visible=False, pty_mode=False)
    await worker.save()

    runtime.start(watchdog=False)
    try:
        created = await flow_runner(bootstrapped_client, monkeypatch)(
            worker, ["task", "create", "--title", "QA cycle", "--brief", "Run the cycle. [short]", "--owner", f"subagent:{name}"])
        assert created["exit_code"] == 0, created
        await runtime.settle()
        task = await Task.get_by_id(created["task"]["id"])
        assert task.process_id, f"the task runtime dispatched no run: {task.status}"
        run = await AgenticProcess.get_by_id(task.process_id.split("agentic_process-")[-1])
    finally:
        await runtime.settle()
        runtime.stop()

    assert qa_mcp.name in [s.name for s in run.resolved_mcp_servers()], "the staff agent's declared MCP server"
    assert run.cli_config.get("model") == "opus", f"the staff agent's options, not the chief's: {run.cli_config}"
    assert "You are the QA tester." in run.context_data["instructions"]
    assert f"You own task {task.id}" in run.context_data["instructions"]
    assert run.load_flowpad_assistant and "agents_json" not in run.cli_config
    assert run.deployment_id is None, "a task run belongs to no placement"
    assert not await Deployment.get_all({"match": {"parent_type_id": str(staff.typeid)}}), "no deployment row made"
