"""An agent runs on places; each place may override how it runs and own its email.

A place is a Deployment of the agent. Its choices live in agent.md keyed by the
Deployment id (``places``, ``email_place``), so they travel with the definition
and each machine applies only the ones naming a placement that runs there.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_places import (
    PlaceError,
    email_answers_here,
    list_places,
    set_email_place,
    set_place_enabled,
    set_place_override,
    version_state,
)
from flow_sdk.builtin.deployment import KIND_AGENT, Deployment
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.trigger_arming import runs_here
from flow_sdk.schema.data_spec.agent_spec import AgentPlaceSpec, AgentSpec
from tests.unit.agent._seed import seed_agent, seed_project

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


async def _agent(tmp_path: Path, name: str, **fields) -> Agent:
    project = await seed_project(tmp_path / f"{name}-project")
    return await seed_agent(Path(project.fs_storage_mount_path), name, project_id=project.id, **fields)


async def _cloud_place(agent: Agent, node: str = "compute_node-11111111-2222-4333-8444-555555555555") -> Deployment:
    deployment = Deployment(
        name=f"{agent.name} (e2b)", kind=KIND_AGENT, parent_type_id=str(agent.typeid),
        target={"provider": "e2b", "scope": "machine", "location": "sandbox"},
        origin={"kind": "e2b", "provider": "e2b", "external_id": node},
    )
    await deployment.save()
    return deployment


def test_a_place_spec_says_only_what_it_overrides():
    place = AgentPlaceSpec(deployment_id="d1", model="sonnet", mcp_servers=["zendesk"])
    assert place.overrides() == {"model": "sonnet", "mcp_servers": ["zendesk"]}
    doc = AgentSpec.model_validate({"places": [{"deployment_id": "d1", "effort": "high"}], "email_place": "d1"})
    assert doc.places[0].effort == "high" and doc.email_place == "d1"
    with pytest.raises(ValueError):
        AgentSpec.model_validate({"places": [{"deployment_id": "d1", "max_turns": 3}]})


@pytest.mark.asyncio
async def test_a_place_override_reaches_the_launch_and_only_that_place(tmp_path):
    agent = await _agent(tmp_path, "places-launch", model="haiku", permission_mode="bypassPermissions")
    local = await agent.local_deployment()
    cloud = await _cloud_place(agent)

    await set_place_override(agent, local.id, "model", "sonnet")
    await set_place_override(agent, local.id, "permission_mode", "askUser")

    fresh = await Agent.get_by_id(agent.id)
    here = await (await Deployment.get_by_id(local.id)).with_element(fresh).create_process("hi")
    there = await (await Deployment.get_by_id(cloud.id)).with_element(fresh).create_process("hi")
    assert here.cli_config["model"] == "sonnet"
    assert here.cli_config["permission_mode"] == "askUser"
    # The other place inherits the definition untouched.
    assert there.cli_config["model"] == "haiku"
    assert there.cli_config["permission_mode"] == "bypassPermissions"


@pytest.mark.asyncio
async def test_overrides_are_written_to_agent_md_and_reset_removes_them(tmp_path):
    agent = await _agent(tmp_path, "places-file", model="haiku", system_prompt="Keep this prompt.")
    local = await agent.local_deployment()
    document = Path(agent.asset_ref) / "agent.md"
    assert "Keep this prompt." in document.read_text()

    await set_place_override(agent, local.id, "effort", "high")
    text = document.read_text()
    assert "places:" in text and local.id in text and "effort: high" in text
    # A header patch: the body (the system prompt) and the other fields survive.
    assert "Keep this prompt." in text and "model: haiku" in text
    assert (await Agent.get_by_id(agent.id)).system_prompt.strip() == "Keep this prompt."

    await set_place_override(agent, local.id, "effort", None)
    assert not (await Agent.get_by_id(agent.id)).places
    assert "places:" not in document.read_text()


@pytest.mark.asyncio
async def test_only_this_agents_places_and_known_fields_are_accepted(tmp_path):
    agent = await _agent(tmp_path, "places-owner")
    other = await _agent(tmp_path, "places-other")
    foreign = await other.local_deployment()

    with pytest.raises(PlaceError) as refused:
        await set_place_override(agent, foreign.id, "model", "sonnet")
    assert refused.value.status_code == 404
    with pytest.raises(PlaceError):
        await set_place_override(agent, (await agent.local_deployment()).id, "system_prompt", "x")


def test_a_hub_recorded_node_id_is_recognised_as_this_machine():
    """The hub records a node as ``compute_node-<uuid>``; the local id is bare.
    Unnormalized, every hub-created placement read as elsewhere — on its own box too."""
    here = Deployment(
        name="here", kind=KIND_AGENT, target={"provider": "e2b", "scope": "machine"},
        origin={"kind": "e2b", "provider": "e2b", "external_id": f"compute_node-{ComputeNode._local_id()}"},
    )
    elsewhere = Deployment(
        name="elsewhere", kind=KIND_AGENT, target={"provider": "e2b", "scope": "machine"},
        origin={"kind": "e2b", "provider": "e2b", "external_id": "compute_node-11111111-2222-4333-8444-555555555555"},
    )
    assert here.is_local is True
    assert elsewhere.is_local is False


@pytest.mark.asyncio
async def test_a_schedule_runs_only_on_its_place(tmp_path):
    from flow_sdk.builtin.trigger import Trigger

    agent = await _agent(tmp_path, "places-runs-on")
    local = await agent.local_deployment()
    cloud = await _cloud_place(agent)

    assert await runs_here(Trigger(name="legacy")) is True
    assert await runs_here(Trigger(name="here", runs_on=local.id)) is True
    assert await runs_here(Trigger(name="cloud", runs_on=cloud.id)) is False
    assert await runs_here(Trigger(name="gone", runs_on="99999999-2222-4333-8444-555555555555")) is False


@pytest.mark.asyncio
async def test_places_list_this_computer_first_with_what_each_owns(tmp_path):
    agent = await _agent(tmp_path, "places-list")
    cloud = await _cloud_place(agent)
    local = await agent.local_deployment()
    await set_place_override(agent, cloud.id, "model", "sonnet")

    rows = await list_places(agent)
    assert [r["deployment"].id for r in rows] == [local.id, cloud.id]
    assert rows[0]["is_local"] is True and rows[1]["is_local"] is False
    assert rows[1]["overrides"] == {"model": "sonnet"}
    # No email place chosen: this computer answers (legacy rule).
    assert [r["answers_email"] for r in rows] == [True, False]


@pytest.mark.asyncio
async def test_email_is_answered_by_exactly_the_chosen_place(tmp_path):
    import flow_sdk.ingest.drivers  # noqa: F401 — register drivers
    from flow_sdk.builtin.data_source import DataSource, SourceStatus
    from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver

    agent = await _agent(tmp_path, "places-email", system_prompt="Answer mail.")
    local = await agent.local_deployment()
    cloud = await _cloud_place(agent)
    source = DataSource(
        name="Inbox", provider=CloudEmailDriver.provider, kind=CloudEmailDriver.kind,
        config={CloudEmailDriver.identity_config_key: agent.id}, account_key="a@x.io",
        owner=agent.typeid, status=SourceStatus.ACTIVE.value,
    )
    await source.save()

    assert await email_answers_here(agent.id) is True

    await set_email_place(agent, cloud.id)
    assert "Answer mail." in (Path(agent.asset_ref) / "agent.md").read_text()
    assert (await DataSource.get_by_id(source.id)).status == SourceStatus.DISABLED.value
    assert await email_answers_here(agent.id) is False
    assert "email_place: " + cloud.id in (Path(agent.asset_ref) / "agent.md").read_text()

    await set_email_place(agent, local.id)
    assert (await DataSource.get_by_id(source.id)).status == SourceStatus.ACTIVE.value
    assert await email_answers_here(agent.id) is True


@pytest.mark.asyncio
async def test_version_counts_what_is_not_published(tmp_path):
    agent = await _agent(tmp_path, "places-version")
    folder = Path(agent.asset_ref)
    assert version_state(agent)["has_repo"] is False

    root = folder.parents[2]
    git = lambda *args: subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)  # noqa: E731
    git("init", "-q")
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "agent")
    state = version_state(agent)
    assert state["has_repo"] is True and state["published"] is False
    assert state["pending_changes"] == 1  # one commit, never published

    (folder / "agent.md").write_text((folder / "agent.md").read_text() + "\nMore.\n")
    assert version_state(agent)["pending_changes"] == 2


@pytest.mark.asyncio
async def test_publish_force_republishes_an_agent_already_on_the_hub(tmp_path, monkeypatch):
    from flow_sdk.builtin import asset_publishing
    from flow_sdk.fs_store.type_id import TypeId

    calls: list[str] = []

    async def _publish(entity, actor):
        calls.append(entity.id)

    async def _no_project(entity):
        return None

    monkeypatch.setattr(asset_publishing, "publish_git_asset", _publish)
    monkeypatch.setattr(asset_publishing, "owning_project", _no_project)
    agent = await _agent(tmp_path, "places-publish")
    agent.remote = True
    object.__setattr__(agent, "origin", {"kind": "git", "head_commit": "abc"})
    actor = TypeId(type="user", id="11111111-2222-4333-8444-555555555555")

    assert await agent.ensure_on_hub(actor) is False
    assert calls == []
    assert await agent.ensure_on_hub(actor, force=True) is True
    assert calls == [agent.id]


@pytest.mark.asyncio
async def test_a_place_can_be_switched_off_on_its_own(tmp_path):
    agent = await _agent(tmp_path, "places-enabled")
    local = await agent.local_deployment()
    cloud = await _cloud_place(agent)

    await set_place_enabled(agent, local.id, False)
    fresh = await Agent.get_by_id(agent.id)
    assert fresh.enabled_on(local.id) is False
    assert fresh.enabled_on(cloud.id) is True, "the other place follows the definition"
    with pytest.raises(RuntimeError, match="disabled"):
        await (await Deployment.get_by_id(local.id)).with_element(fresh).create_process("hi")
    assert "enabled: false" in (Path(agent.asset_ref) / "agent.md").read_text()

    with pytest.raises(PlaceError):
        await set_place_enabled(fresh, local.id, "no")
    await set_place_enabled(fresh, local.id, None)
    assert (await Agent.get_by_id(agent.id)).enabled_on(local.id) is True
