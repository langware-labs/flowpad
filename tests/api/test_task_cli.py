"""``flow task …`` — every verb through the real CLI, as the process that calls it. Who you are is
never an argument: a chief's worker acts as its agent, a task's run only as that task's owner, and
the ledger refuses the rest (exit 7)."""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.task import Task
from tests.utils.mock_behaviors import flow_runner
from tests.utils.mock_worker import mock_driver_for

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

REFUSED = 7


@pytest.fixture
async def project(tmp_path, bootstrapped_client):
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    root = tmp_path / "proj"
    root.mkdir()
    return await Project(id=mint_uuid(), name=f"cli-{mint_uuid()[:8]}", fs_storage_mount_path=str(root)).save()


@pytest.fixture
async def cast(project, bootstrapped_client, monkeypatch, tmp_path):
    """The chief's worker, and ``run_for(task_id)`` — a run that owns one task."""
    driver = mock_driver_for("claude", tmp_path / "t", behavior=lambda turn: "ok")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: driver)
    agent = await Agent(name=f"Dana {uuid.uuid4().hex[:6]}", worker_type="claude", chief_of_staff=True,
                        project_id=project.id).save()
    chief = await (await agent.local_deployment()).create_process(
        "", target_typeid_str=f"conversation-{uuid.uuid4()}", visible=False, pty_mode=False)
    await chief.save()

    async def run_for(task_id: str):
        return await AgenticProcess(name="run", project_id=project.id, visible=False, pty_mode=False,
                                    context_data={"task_id": task_id}).save()

    return {"agent": agent, "chief": chief, "run_for": run_for, "flow": flow_runner(bootstrapped_client, monkeypatch)}


async def test_a_task_lives_its_life_through_the_cli(cast, project):
    flow, chief = cast["flow"], cast["chief"]
    created = await flow(chief, ["task", "create", "--title", "Summarise Q3", "--brief", "notes/ → summary.md"])
    assert created["exit_code"] == 0, created
    task = created["task"]
    assert task["creator"] == f"agent:{cast['agent'].id}" and task["owner"] == "subagent:general-worker"
    assert task["status"] == "submitted" and task["placement"] == "instance"

    run = await cast["run_for"](task["id"])
    for argv in (["start", task["id"]], ["note", task["id"], "read 4 of 9"], ["ask", task["id"], "Fiscal or calendar?"]):
        result = await flow(run, ["task", *argv])
        assert result["exit_code"] == 0, (argv, result)
    listed = await flow(chief, ["task", "list"])
    assert [(t["id"], t["status"]) for t in listed["tasks"]] == [(task["id"], "input_required")]
    assert (await flow(chief, ["task", "reply", task["id"], "Calendar."]))["task"]["status"] == "working"
    done = await flow(run, ["task", "done", task["id"], "--result", "3 themes", "--artifact", "summary.md"])
    assert done["task"]["status"] == "done" and done["task"]["artifacts"] == ["summary.md"]

    shown = (await flow(chief, ["task", "show", task["id"]]))["task"]
    assert [(e["event"], e["author"].split(":")[0]) for e in shown["log"]] == [
        ("created", "agent"), ("started", "subagent"), ("note", "subagent"), ("asked", "subagent"),
        ("replied", "agent"), ("done", "subagent"),
    ]
    assert shown["brief"] == "notes/ → summary.md" and shown["result"] == "3 themes"
    assert not list(Path(project.fs_storage_mount_path).rglob("*.md")), "nothing written into the project"


async def test_each_caller_may_do_only_its_part(cast):
    flow, chief = cast["flow"], cast["chief"]
    first = (await flow(chief, ["task", "create", "--title", "One", "--brief", "b"]))["task"]["id"]
    second = (await flow(chief, ["task", "create", "--title", "Two", "--brief", "b"]))["task"]["id"]
    run = await cast["run_for"](first)

    refused = {
        "a run acting on another task": await flow(run, ["task", "start", second]),
        "a run canceling (the creator's call)": await flow(run, ["task", "cancel", first]),
        "a run keeping its task in the project": await flow(run, ["task", "keep", first]),
        "the chief finishing its staff's task": await flow(chief, ["task", "done", first, "--result", "x"]),
        "asking before starting": await flow(run, ["task", "ask", first, "?"]),
    }
    assert {why: r["exit_code"] for why, r in refused.items()} == dict.fromkeys(refused, REFUSED)

    assert (await flow(chief, ["task", "cancel", first, "not needed"]))["task"]["status"] == "canceled"
    after = await flow(run, ["task", "note", first, "too late"])
    assert after["exit_code"] == REFUSED and "canceled" in str(after), after


async def test_keep_puts_a_task_in_the_project_on_the_persons_word(cast, project):
    flow, chief = cast["flow"], cast["chief"]
    task_id = (await flow(chief, ["task", "create", "--title", "Launch note", "--brief", "b"]))["task"]["id"]
    kept = await flow(chief, ["task", "keep", task_id])
    assert kept["exit_code"] == 0 and kept["task"]["placement"] == "repo", kept
    assert (Path(project.fs_storage_mount_path) / kept["task"]["asset_ref"]).exists() or \
        Path(kept["task"]["asset_ref"]).exists()
    assert (await Task.get_by_id(task_id)).is_file_backed()
