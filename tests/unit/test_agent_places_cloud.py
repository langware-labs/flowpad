"""A cloud place, seen from both ends of the wire.

On the cloud machine: the hub hands the box its placement id (``adopt_placement``)
so the definition's place entries — keyed by that id — apply there.

On this computer: a cloud card's verbs (resume, update, its runs) are relayed to
the hub, which alone can reach the box; and the card says how many published
commits the box is behind. The hub is faked at ``hub_http``. No network.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_places import PlaceError, adopt_placement, behind_count, list_places
from flow_sdk.builtin.deployment import KIND_AGENT, Deployment, DeploymentActionError
from tests.unit.agent._seed import seed_agent, seed_project

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

HUB_ID = "7b0f6c1e-3d2a-4f5b-9c8d-1e2f3a4b5c6d"


async def _agent(tmp_path: Path, name: str, **fields) -> Agent:
    project = await seed_project(tmp_path / f"{name}-project")
    return await seed_agent(Path(project.fs_storage_mount_path), name, project_id=project.id, **fields)


async def _cloud_place(agent: Agent, **fields) -> Deployment:
    deployment = Deployment(
        name=f"{agent.name} (e2b)",
        kind=KIND_AGENT,
        parent_type_id=str(agent.typeid),
        target={"provider": "e2b", "scope": "machine", "location": "sandbox"},
        origin={"kind": "e2b", "provider": "e2b", "external_id": "compute_node-11111111-2222-4333-8444-555555555555"},
        **fields,
    )
    await deployment.save()
    return deployment


class _Hub:
    def __init__(self, configured: bool = True):
        self.calls: list[tuple] = []
        self.configured = configured

    async def post(self, etype, payload, eid=None, action=None, **_):
        self.calls.append(("POST", etype, eid, action))
        return {"deployment_id": eid, "source_revision": "abc"} if self.configured else None

    async def get(self, etype, eid=None, action=None, **kw):
        self.calls.append(("GET", etype, eid, action, kw.get("params")))
        return {"runs": [{"id": "r1", "badge": "done"}, "junk"]} if self.configured else None


@pytest.fixture
def hub(monkeypatch):
    fake = _Hub()
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", fake.post)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", fake.get)
    return fake


# ── on the cloud machine ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_adopt_placement_rekeys_this_machines_placement_to_the_hub_id(tmp_path):
    agent = await _agent(tmp_path, "adopt-rekey")
    minted = await agent.local_deployment()
    assert minted.id != HUB_ID

    adopted = await adopt_placement(agent, HUB_ID)

    assert adopted.id == HUB_ID and adopted.is_local
    assert await Deployment.get_by_id(minted.id) is None, "one placement, one id — the minted row is gone"
    # Every later lookup converges on the adopted row, so the place entries keyed
    # by the hub id are the ones this machine applies.
    assert (await agent.local_deployment()).id == HUB_ID
    again = await adopt_placement(agent, HUB_ID)
    assert again.id == HUB_ID
    assert [d.id for d in await agent.deployments()] == [HUB_ID]


@pytest.mark.asyncio
async def test_adopt_placement_refuses_a_bad_or_foreign_id(tmp_path):
    agent = await _agent(tmp_path, "adopt-owner")
    other = await _agent(tmp_path, "adopt-other")
    foreign = await other.local_deployment()
    cloud = await _cloud_place(agent)

    with pytest.raises(PlaceError):
        await adopt_placement(agent, "not-a-uuid")
    with pytest.raises(PlaceError) as elsewhere:
        await adopt_placement(agent, foreign.id)
    assert elsewhere.value.status_code == 409
    with pytest.raises(PlaceError) as not_here:
        await adopt_placement(agent, cloud.id)
    assert not_here.value.status_code == 409


# ── on this computer: behind ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_behind_counts_published_commits_the_machine_lacks(tmp_path):
    agent = await _agent(tmp_path, "behind-count")
    folder = Path(agent.asset_ref)
    root = folder.parents[2]

    def git(*args) -> str:
        out = subprocess.run(
            ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
        return out.stdout.strip()

    git("init", "-q")
    git("add", "-A")
    git("commit", "-q", "-m", "first")
    deployed = git("rev-parse", "HEAD")
    (folder / "agent.md").write_text((folder / "agent.md").read_text() + "\nSecond.\n")
    git("commit", "-q", "-am", "second")
    (root / "unrelated.txt").write_text("x")
    git("add", "-A")
    git("commit", "-q", "-m", "outside the agent")
    published = git("rev-parse", "HEAD")

    assert behind_count(agent, deployed, published) == 1, "only commits touching the agent's folder count"
    assert behind_count(agent, published, published) == 0
    assert behind_count(agent, None, published) is None
    assert behind_count(agent, deployed, "") is None

    cloud = await _cloud_place(agent, source_revision=deployed)
    object.__setattr__(agent, "origin", SimpleNamespace(kind="git", head_commit=published))
    rows = {row["deployment"].id: row for row in await list_places(agent)}
    assert rows[cloud.id]["behind"] == 1
    assert rows[(await agent.local_deployment()).id]["behind"] is None


# ── on this computer: relayed verbs ───────────────────────────────────────


@pytest.mark.asyncio
async def test_a_cloud_machines_verbs_go_through_the_hub(tmp_path, hub):
    agent = await _agent(tmp_path, "relay-verbs")
    cloud = await _cloud_place(agent)
    cloud.remote = True

    assert await cloud.update() == {"deployment_id": cloud.id, "source_revision": "abc"}
    assert await cloud.resume() is True
    runs = await cloud.remote_runs(limit=5)

    assert runs == [{"id": "r1", "badge": "done"}]
    assert hub.calls == [
        ("POST", "deployment", cloud.id, "update"),
        ("POST", "deployment", cloud.id, "resume"),
        ("GET", "deployment", cloud.id, "runs", {"limit": "5"}),
    ]


@pytest.mark.asyncio
async def test_this_computer_has_no_update_or_remote_runs(tmp_path, hub):
    agent = await _agent(tmp_path, "relay-local")
    local = await agent.local_deployment()

    with pytest.raises(DeploymentActionError) as update:
        await local.update()
    assert update.value.status_code == 409
    with pytest.raises(DeploymentActionError):
        await local.remote_runs()
    assert hub.calls == []


@pytest.mark.asyncio
async def test_a_relay_without_a_hub_says_to_log_in(tmp_path, hub):
    hub.configured = False
    agent = await _agent(tmp_path, "relay-offline")
    cloud = await _cloud_place(agent)

    with pytest.raises(DeploymentActionError) as update:
        await cloud.update()
    assert update.value.status_code == 401
    with pytest.raises(DeploymentActionError) as runs:
        await cloud.remote_runs()
    assert runs.value.status_code == 502
