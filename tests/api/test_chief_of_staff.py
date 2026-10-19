"""Chief of Staff mode is checkbox-gated: what a launch carries with it on, that nothing changes with
it off, and that the agent's Tasks channel follows the checkbox — for every worker vendor, as the
MockWorker sees the launch (``tests/utils/mock_worker.py``)."""
from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_serve import AgentServer
from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.tasks import cos
from flow_sdk.tasks.cos import COS_MARKER, DEFAULT_STAFF, sync_tasks_channel
from tests.utils.mock_worker import MOCK_VENDORS, mock_driver_for

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("bootstrapped_client")]  # do not increase timeout without approval

SPAWNING = {"claude"}


@pytest.fixture
async def project(tmp_path):
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    root = tmp_path / "proj"
    root.mkdir()
    return await Project(id=mint_uuid(), name=f"cos-{mint_uuid()[:8]}", fs_storage_mount_path=str(root)).save()


async def _agent(project, vendor="claude", **fields):
    agent = Agent(name=f"Dana {uuid.uuid4().hex[:6]}", worker_type=vendor, system_prompt="You are Dana.",
                  project_id=project.id, **fields)
    return await agent.save()


async def _launch(agent, driver, monkeypatch):
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: driver)
    deployment = await agent.local_deployment()
    process = await deployment.create_process("", target_typeid_str=f"conversation-{uuid.uuid4()}", visible=False,
                                              pty_mode=False)
    return process, await driver._mock_turn(process)  # noqa: SLF001 — what the worker would receive


@pytest.mark.parametrize("vendor", MOCK_VENDORS)
async def test_off_the_launch_is_what_it_was_before_the_mode_existed(vendor, project, monkeypatch, tmp_path):
    driver = mock_driver_for(vendor, tmp_path / "t", behavior=lambda turn: "ok")
    agent = await _agent(project, vendor)
    process, turn = await _launch(agent, driver, monkeypatch)

    monkeypatch.setattr(cos, "apply_to_launch", lambda *a, **k: {})
    without, turn_without = await _launch(agent, driver, monkeypatch)

    def same(a, b) -> bool:  # byte for byte, but for the per-process id each launch names (its output folder)
        return json.dumps(a, sort_keys=True, default=str).replace(process.id, "<id>") == \
            json.dumps(b, sort_keys=True, default=str).replace(without.id, "<id>")

    assert same(process.context_data, without.context_data) and "chief_of_staff" not in (process.context_data or {})
    assert same(process.cli_config, without.cli_config) and not (process.cli_config or {}).get("agents_json")
    assert process.load_flowpad_assistant == without.load_flowpad_assistant
    assert same(turn.instructions, turn_without.instructions) and COS_MARKER not in turn.instructions
    assert not turn.is_chief_of_staff and turn.agents == {}


@pytest.mark.parametrize("vendor", MOCK_VENDORS)
async def test_on_the_worker_is_told_it_is_a_chief_of_staff_in_its_own_vendors_projection(vendor, project, monkeypatch, tmp_path):
    driver = mock_driver_for(vendor, tmp_path / "t", behavior=lambda turn: "ok")
    agent = await _agent(project, vendor, chief_of_staff=True)
    process, turn = await _launch(agent, driver, monkeypatch)

    assert process.context_data["chief_of_staff"] is True and process.load_flowpad_assistant is True
    assert turn.is_chief_of_staff and "You are Dana." in turn.instructions
    assert "task-management" in turn.skills, turn.skills
    assert f"subagent:{DEFAULT_STAFF}" in turn.instructions
    assert "# Your open tasks" in turn.instructions, "each turn carries the ledger"
    # The native roster only where the harness spawns subagents itself; elsewhere even short jobs are tasks.
    assert bool(turn.agents) == (vendor in SPAWNING) and turn.spawns_subagents == (vendor in SPAWNING)
    if vendor in SPAWNING:
        assert DEFAULT_STAFF in turn.agents
        assert "native subagent tool" in turn.instructions
    else:
        assert "cannot run a subagent itself" in turn.instructions


async def test_staff_that_resolve_nowhere_are_never_offered(project, monkeypatch, tmp_path):
    (tmp_path / "proj" / ".claude" / "agents").mkdir(parents=True)
    (tmp_path / "proj" / ".claude" / "agents" / "researcher.md").write_text(
        "---\nname: researcher\ndescription: Finds things out.\n---\nYou research.\n", encoding="utf-8")
    driver = mock_driver_for("claude", tmp_path / "t", behavior=lambda turn: "ok")
    agent = await _agent(project, chief_of_staff=True, subagents=["researcher", "ghost"])
    _process, turn = await _launch(agent, driver, monkeypatch)

    assert "subagent:researcher" in turn.instructions and "ghost" not in turn.instructions
    assert set(turn.agents) == {"researcher", DEFAULT_STAFF}, "the agent's own project staff are found"


async def test_the_tasks_channel_follows_the_checkbox_and_writes_only_on_change(project, monkeypatch):
    agent = await _agent(project, chief_of_staff=True)
    server = AgentServer(run_processes=False)

    await server._sync_chiefs_of_staff()  # noqa: SLF001
    channel = await sync_tasks_channel(agent)
    assert channel is not None and channel.status == SourceStatus.ACTIVE.value
    assert channel.owner == agent.typeid and channel.account_key == f"agent:{agent.id}"

    saves = []
    original = DataSource.save

    async def counting(self, *a, **k):
        saves.append(self.id)
        return await original(self, *a, **k)

    monkeypatch.setattr(DataSource, "save", counting)
    await server._sync_chiefs_of_staff()  # noqa: SLF001
    assert saves == [], "an unchanged channel is not rewritten on every reconcile"

    agent.chief_of_staff = False
    await agent.save()
    await server._sync_chiefs_of_staff()  # noqa: SLF001 — a fresh server would do the same: read, not remembered
    assert (await DataSource.get_one({"id": channel.id})).status == SourceStatus.DISABLED.value
    await AgentServer(run_processes=False)._sync_chiefs_of_staff()  # noqa: SLF001
    assert saves == [channel.id], "paused once"
