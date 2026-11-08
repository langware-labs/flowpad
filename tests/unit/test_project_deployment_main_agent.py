"""A deployment places a PROJECT with one optional main agent.

The project recommends its main agent in git (``flow.json`` ``mainAgent``); a deployment copies that as
its default and may name another — stored on the row, never in git. Rows stored when an agent was the
parent are lifted onto the project at boot, keeping their id.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.deployment import Deployment
from tests.unit.agent._seed import seed_agent, seed_project

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


async def _project_with(tmp_path: Path, *names: str, main: str | None = None):
    project = await seed_project(tmp_path / "proj")
    root = Path(project.fs_storage_mount_path)
    if main:
        (root / "flow.json").write_text(json.dumps({"mainAgent": main}), encoding="utf-8")
    agents = [await seed_agent(root, n, project_id=project.id) for n in names]
    return project, agents


@pytest.mark.asyncio
async def test_a_deployment_takes_the_recommended_main_agent_unless_it_names_another(tmp_path):
    project, (helper, other) = await _project_with(tmp_path, "helper", "other", main="helper")

    assert (await project.recommended_main_agent()).id == helper.id
    assert (await project.main_agent_for()).id == helper.id, "nothing named: the recommendation"
    assert (await project.main_agent_for(str(other.typeid), given=True)).id == other.id, "named: the override"
    assert await project.main_agent_for("", given=True) is None, "named empty: no agent"

    local = await project.local_deployment()
    assert local.parent_type_id == str(project.typeid)
    assert (local.main_agent_id, local.identity) == (str(helper.typeid), "agent")
    # The override is the row's, and git keeps recommending what it did.
    await project.deploy(None, provider="local", main_agent=other)
    assert (await Deployment.get_by_id(local.id)).main_agent_id == str(other.typeid)
    assert (await project.recommended_main_agent()).id == helper.id
    assert (await project.local_deployment()).id == local.id, "one local deployment per project"


@pytest.mark.asyncio
async def test_a_project_without_a_recommendation_deploys_with_no_agent(tmp_path):
    project, _ = await _project_with(tmp_path, "helper")
    local = await project.local_deployment()
    assert (local.main_agent_id, local.identity, local.places_agent) == (None, "none", False)


@pytest.mark.asyncio
async def test_an_agent_row_becomes_its_projects_row_with_the_same_id(tmp_path):
    from flow_sdk.cli import app_config
    from flow_sdk.migrations import migration_2026_11_project_deployments as lift

    project, (agent,) = await _project_with(tmp_path, "legacy")
    web = Deployment(name="web", parent_type_id=str(project.typeid), target={"provider": "local", "scope": "p"})
    await web.save()
    old = Deployment(
        name="legacy (local)",
        parent_type_id=str(agent.typeid),
        identity="agent",
        source_revision="abc123",
        target={"provider": "local", "scope": "p"},
    )
    await old.save()
    cloud = Deployment(
        name="legacy (e2b)",
        parent_type_id=str(agent.typeid),
        target={"provider": "e2b", "scope": "machine"},
    )
    await cloud.save()
    doc = Path(agent.asset_ref) / "agent.json"
    doc.write_text(json.dumps({"places": [{"deployment_id": cloud.id, "model": "sonnet", "enabled": False}]}))
    app_config.set_config(lift.DONE_KEY, False)

    report = await lift.lift(dry_run=False, force=True)

    assert not [f for f in report.failed if old.id in f or cloud.id in f], report.failed
    for row_id, provider in ((old.id, "local"), (cloud.id, "e2b")):
        row = await Deployment.get_by_id(row_id)
        assert row.parent_type_id == str(project.typeid) and row.main_agent_id == str(agent.typeid)
        assert row.target.provider == provider
    assert (await Deployment.get_by_id(old.id)).source_ref == "abc123"
    assert (await Deployment.get_by_id(cloud.id)).main_agent_overrides == {"model": "sonnet"}
    assert await Deployment.get_by_id(web.id) is None, "the project's local web row merged into the agent's"
    assert (await project.local_deployment()).id == old.id


@pytest.mark.asyncio
async def test_a_machine_adopting_a_record_with_no_main_agent_stops_serving_it(tmp_path):
    """The hub clears a deployment's main agent: the box's row loses it too and stops serving -- a cleared
    field is the record, not an absent one (found by the concurrent-deploy stress run)."""
    from flow_sdk.builtin.agent_places import adopt_deployment

    project, (helper,) = await _project_with(tmp_path, "helper", main="helper")
    local = await project.local_deployment()
    local.serving = True
    await local.save()
    record = {"id": local.id, "parent_type_id": str(project.typeid), "main_agent_id": None, "identity": "none"}

    adopted = await adopt_deployment(record)

    row = await Deployment.get_by_id(local.id)
    assert (adopted.main_agent_id, row.main_agent_id, row.serving, row.identity) == (None, None, False, "none")


@pytest.mark.asyncio
async def test_the_supervisor_keeps_a_cleared_main_agent_cleared_and_stops_its_loop(tmp_path, monkeypatch):
    """Two races the concurrent-deploy stress run found on a box: starting a loop wrote the copy read
    before the start back over a main agent the hub had just cleared, and a deployment left with no main
    agent was never seen again, so its loop ran on."""
    from flow_sdk.builtin import agent_serve, deployment_process

    project, (helper,) = await _project_with(tmp_path, "helper", main="helper")
    stale = await project.local_deployment()

    async def _start(deployment):
        # The hub's adopt lands while the loop starts: the row loses its main agent.
        row = await Deployment.get_by_id(stale.id)
        row.main_agent_id, row.serving = None, False
        await row.save()
        return {deployment_process.SHELL_LABEL: "shell-1"}

    async def _no_channel(*_args, **_kwargs):
        return None

    monkeypatch.setattr(deployment_process, "start", _start)
    monkeypatch.setattr(deployment_process, "alive", lambda _d: False)
    monkeypatch.setattr(agent_serve, "ensure_chat_channel", _no_channel)
    server = agent_serve.AgentServer(run_processes=False)

    await server._keep_running(helper, stale)

    row = await Deployment.get_by_id(stale.id)
    assert row.main_agent_id is None, "the start's labels must not write the stale main agent back"
    assert row.provider_labels.get(deployment_process.SHELL_LABEL) == "shell-1"

    server._running.clear()
    monkeypatch.setattr(deployment_process, "alive", lambda _d: True)
    wanted, strays = await server._wanted()
    assert stale.id not in wanted and stale.id in [d.id for d in strays], "its loop is a stray to stop"
