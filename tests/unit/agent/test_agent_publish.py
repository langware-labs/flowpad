"""Publishing an agent to the hub — into its project's hub repo, id verbatim, once."""

from unittest.mock import AsyncMock

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin
from flow_sdk.fs_store.type_id import TypeId


async def test_publish_is_idempotent(monkeypatch):
    """A second deploy must not re-publish.

    A complete publication has both ``remote`` and a hub-repo origin — the
    project's hosted repository the deployment clones, and the asset's place in it.
    """
    calls: list[int] = []

    async def _publish(entity, actor):
        calls.append(1)
        entity.remote = True
        entity.origin = HubRepoOrigin(
            repo="git_repo-" + "1" * 32, rel_path="agentic-assets/agent/joe", head_commit="a" * 40, tree="b" * 40
        )

    monkeypatch.setattr("flow_sdk.builtin.asset_publishing.publish_git_asset", _publish)

    agent = Agent(name="joe")
    actor = TypeId(type="user", id=mint_uuid())
    assert await agent.ensure_on_hub(actor) is True
    assert agent.remote is True
    assert agent.origin.rel_path == "agentic-assets/agent/joe"
    # second call is a no-op
    assert await agent.ensure_on_hub(actor) is False
    assert calls == [1]


async def test_legacy_remote_without_a_hub_repo_origin_is_republished(monkeypatch):
    """The former field-only share (or a GitHub origin) must not poison deploy idempotency."""
    calls: list[int] = []

    async def _publish(entity, actor):
        calls.append(1)
        entity.remote = True
        entity.origin = {"rel_path": "agentic-assets/agent/joe"}

    monkeypatch.setattr("flow_sdk.builtin.asset_publishing.publish_git_asset", _publish)
    agent = Agent(name="joe", remote=True)

    assert await agent.ensure_on_hub(TypeId(type="user", id=mint_uuid())) is True
    assert calls == [1]


async def test_fresh_agent_publishes_owning_project_before_asset(monkeypatch):
    """One Deploy click establishes the required parent-before-child order."""
    events: list[str] = []
    project = Project(id=mint_uuid(), name="flowpad-os", remote=False)
    agent = Agent(id=mint_uuid(), name="joe", project_id=project.id)

    async def _ensure_project(_project):
        events.append("project")
        _project.remote = True
        return True

    async def _publish_asset(_entity, _actor):
        events.append("agent")

    monkeypatch.setattr("flow_sdk.builtin.asset_publishing.owning_project", AsyncMock(return_value=project))
    monkeypatch.setattr(Project, "ensure_on_hub", _ensure_project)
    monkeypatch.setattr("flow_sdk.builtin.asset_publishing.publish_git_asset", _publish_asset)

    assert await agent.ensure_on_hub(TypeId(type="user", id=mint_uuid())) is True
    assert events == ["project", "agent"]


async def test_a_git_project_sends_its_files_before_its_agent(monkeypatch, tmp_path):
    """The hub stands an agent up inside its project, so the project's files go first."""
    events: list[str] = []
    (tmp_path / ".git").mkdir()
    project = Project(id=mint_uuid(), name="q", remote=True, fs_storage_mount_path=str(tmp_path))
    agent = Agent(id=mint_uuid(), name="joe", project_id=project.id)

    monkeypatch.setattr("flow_sdk.builtin.asset_publishing.owning_project", AsyncMock(return_value=project))
    monkeypatch.setattr(Project, "publish_files_to_hub", AsyncMock(side_effect=lambda: events.append("files")))
    monkeypatch.setattr(
        "flow_sdk.builtin.asset_publishing.publish_git_asset", AsyncMock(side_effect=lambda *_a: events.append("agent"))
    )

    assert await agent.ensure_on_hub(TypeId(type="user", id=mint_uuid())) is True
    assert events == ["files", "agent"]


async def test_project_ensure_on_hub_is_persisted_and_idempotent(monkeypatch):
    project = Project(id=mint_uuid(), name="flowpad-os", remote=False)
    share = AsyncMock(return_value=project)
    save = AsyncMock(return_value=project)
    monkeypatch.setattr(Project, "share", share)
    monkeypatch.setattr(Project, "save", save)

    assert await project.ensure_on_hub() is True
    assert project.remote is True
    share.assert_awaited_once_with()
    save.assert_awaited_once_with()

    assert await project.ensure_on_hub() is False
    share.assert_awaited_once_with()
    save.assert_awaited_once_with()


def test_local_path_never_travels_to_the_hub():
    """`asset_ref` is an absolute path on THIS machine.

    It is Sharing.PRIVATE precisely so publishing cannot leak it. The portable
    locator is the hub-repo origin's ``rel_path``; the Hub reads files from its repo.
    """
    excluded = Agent.fields_not_sent_to_hub()
    assert "asset_ref" in excluded


def test_the_launch_bundle_does_travel():
    """Publishing is worthless if the persona and model stay behind."""
    excluded = set(Agent.fields_not_sent_to_hub())
    for field in ("system_prompt", "avatar", "model", "worker_type", "permission_mode"):
        assert field not in excluded, f"{field} must reach the hub"
