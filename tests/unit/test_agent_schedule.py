"""A schedule is a child trigger asset of its agent — written, indexed, armed.

What is under test is the authoring seam (``flow_sdk/builtin/agent_schedule``):
the document lands under the agent's own ``agentic-assets/trigger/``, the row is
parented to the agent (so the agent's Schedule tab can find it), and the
APScheduler job exists, in the right zone, paused when disabled and gone when
removed. The fire itself is covered by
``test_system_heartbeat/test_fire_schedule_job_dispatches_actions.py`` and, for
real, by ``tests/long_tests/test_scheduled_agent_run_flow.py``.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.agent_schedule import ScheduleError, add_schedule, remove_schedule, update_schedule
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.schema.data_spec.trigger_action import ActionType
from flow_sdk.schema.data_spec.trigger_types import TriggerType
from tests.unit.agent._seed import seed_agent, seed_project

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

BODY = {
    "name": "Morning triage",
    "every": "cron",
    "expr": "0 9 * * 1-5",
    "timezone": "Asia/Jerusalem",
    "prompt": "Triage yesterday's tickets",
}


@pytest.fixture
async def scheduler(monkeypatch):
    """A private, started scheduler in place of the instance singleton, so a
    test never leaves jobs in the shared persistent jobstore."""
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    import flow_sdk.server.scheduler as scheduler_module

    private = AsyncIOScheduler()
    private.start()
    monkeypatch.setattr(scheduler_module, "get_scheduler", lambda: private)
    yield private
    private.shutdown(wait=False)


async def _agent(tmp_path: Path, name: str):
    project = await seed_project(tmp_path / f"{name}-project")
    return await seed_agent(Path(project.fs_storage_mount_path), name, project_id=project.id)


def _schedule_folder(agent, slug: str = "morning-triage") -> Path:
    return Path(agent.asset_ref) / "agentic-assets" / "trigger" / slug


@pytest.mark.asyncio
async def test_add_writes_a_child_asset_parents_it_and_arms_it(tmp_path, scheduler):
    agent = await _agent(tmp_path, "sched-add")

    trigger = await add_schedule(agent, BODY)

    folder = _schedule_folder(agent)
    assert json.loads((folder / "trigger.json").read_text()) == {
        "name": "Morning triage",
        "schedule": {"every": "cron", "expr": "0 9 * * 1-5", "timezone": "Asia/Jerusalem"},
        # Empty agent = "my parent": the document stays portable to any machine.
        "actions": [{"run_agent": {"prompt": "Triage yesterday's tickets"}}],
    }
    assert Path(trigger.asset_ref).resolve() == folder.resolve()
    # The Schedule tab lists by containment; a parentless row would be invisible.
    assert trigger.parent_type_id == str(agent.typeid)
    assert trigger.trigger_type == TriggerType.SCHEDULE
    assert [(a.action_type, a.prompt) for a in trigger.actions] == [(ActionType.RUN_AGENT, "Triage yesterday's tickets")]

    job = scheduler.get_job(trigger.id)
    assert job is not None, "indexed but never armed"
    assert str(job.trigger.timezone) == "Asia/Jerusalem"
    assert job.next_run_time is not None


@pytest.mark.asyncio
async def test_update_changes_only_what_it_manages_and_pauses_when_disabled(tmp_path, scheduler):
    agent = await _agent(tmp_path, "sched-update")
    trigger = await add_schedule(agent, BODY)
    document = _schedule_folder(agent) / "trigger.json"
    # Someone edits the document by hand; a UI edit must not erase it.
    hand = json.loads(document.read_text())
    hand["description"] = "written by hand"
    hand["fire_once"] = True
    document.write_text(json.dumps(hand))

    updated = await update_schedule(agent, trigger.id, {"expr": "30 8 * * *", "enabled": False})

    on_disk = json.loads(document.read_text())
    assert on_disk["description"] == "written by hand"
    assert on_disk["fire_once"] is True
    assert on_disk["schedule"]["expr"] == "30 8 * * *"
    assert on_disk["enabled"] is False
    assert on_disk["actions"] == [{"run_agent": {"prompt": "Triage yesterday's tickets"}}]
    assert updated.id == trigger.id, "an edit must keep the trigger's identity"
    assert updated.enabled is False and updated.expr == "30 8 * * *"
    assert updated.parent_type_id == str(agent.typeid)
    assert scheduler.get_job(trigger.id).next_run_time is None, "a disabled schedule must be paused"


@pytest.mark.asyncio
async def test_remove_takes_the_folder_the_row_and_the_job(tmp_path, scheduler):
    agent = await _agent(tmp_path, "sched-remove")
    trigger = await add_schedule(agent, BODY)

    await remove_schedule(agent, trigger.id)

    assert not _schedule_folder(agent).exists()
    assert await Trigger.get_by_id(trigger.id) is None
    assert scheduler.get_job(trigger.id) is None


@pytest.mark.asyncio
async def test_a_bad_schedule_is_refused_before_anything_is_written(tmp_path, scheduler):
    agent = await _agent(tmp_path, "sched-bad")
    for bad in ({**BODY, "expr": "every morning"}, {**BODY, "timezone": "Mars/Olympus"},
                {**BODY, "prompt": "  "}, {**BODY, "every": "weekly"}, {**BODY, "name": ""}):
        with pytest.raises(ScheduleError):
            await add_schedule(agent, bad)
    assert not (Path(agent.asset_ref) / "agentic-assets" / "trigger").exists()


@pytest.mark.asyncio
async def test_a_schedule_belongs_to_its_own_agent_only(tmp_path, scheduler):
    owner = await _agent(tmp_path, "sched-owner")
    stranger = await _agent(tmp_path, "sched-stranger")
    trigger = await add_schedule(owner, BODY)

    with pytest.raises(ScheduleError) as refused:
        await remove_schedule(stranger, trigger.id)
    assert refused.value.status_code == 404
    assert _schedule_folder(owner).exists()


# ── a schedule belongs to one place ─────────────────────────────────────────

async def _cloud_place(agent):
    from flow_sdk.builtin.deployment import KIND_AGENT, Deployment

    deployment = Deployment(
        name=f"{agent.name} (e2b)", kind=KIND_AGENT, parent_type_id=str(agent.typeid),
        target={"provider": "e2b", "scope": "machine", "location": "sandbox"},
        origin={"kind": "e2b", "provider": "e2b", "external_id": "compute_node-11111111-2222-4333-8444-555555555555"},
    )
    await deployment.save()
    return deployment


@pytest.mark.asyncio
async def test_a_schedule_on_this_computer_is_armed_here(tmp_path, scheduler):
    agent = await _agent(tmp_path, "sched-here")
    local = await agent.local_deployment()

    trigger = await add_schedule(agent, {**BODY, "runs_on": local.id})

    on_disk = json.loads((_schedule_folder(agent) / "trigger.json").read_text())
    assert on_disk["schedule"]["runs_on"] == local.id
    assert trigger.runs_on == local.id
    assert scheduler.get_job(trigger.id) is not None


@pytest.mark.asyncio
async def test_a_cloud_places_schedule_is_written_but_never_armed_here(tmp_path, scheduler):
    """The file travels to the cloud machine by publish + update; this computer
    holds it and must not run it."""
    agent = await _agent(tmp_path, "sched-cloud")
    cloud = await _cloud_place(agent)

    trigger = await add_schedule(agent, {**BODY, "runs_on": cloud.id})

    assert trigger.runs_on == cloud.id
    assert scheduler.get_job(trigger.id) is None


@pytest.mark.asyncio
async def test_a_schedule_cannot_run_on_another_agents_place(tmp_path, scheduler):
    agent = await _agent(tmp_path, "sched-mine")
    other = await _agent(tmp_path, "sched-theirs")
    with pytest.raises(ScheduleError) as refused:
        await add_schedule(agent, {**BODY, "runs_on": (await other.local_deployment()).id})
    assert refused.value.status_code == 404


@pytest.mark.asyncio
async def test_moving_a_schedule_to_another_place_disarms_it_here(tmp_path, scheduler):
    agent = await _agent(tmp_path, "sched-move")
    local = await agent.local_deployment()
    cloud = await _cloud_place(agent)
    trigger = await add_schedule(agent, {**BODY, "runs_on": local.id})
    assert scheduler.get_job(trigger.id) is not None

    await update_schedule(agent, trigger.id, {"runs_on": cloud.id})
    assert scheduler.get_job(trigger.id) is None
