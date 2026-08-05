from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from flow_sdk.assets.git_origin import PortableGitOrigin
from flow_sdk.assets.git_publish import (
    AssetGitReceipt,
    AssetPublishCode,
    AssetPublishError,
    GitAuthor,
    publish_git_asset,
)
from flow_sdk.assets.projection import PortableAssetLayout, PortableAssetProjection
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.type_id import TypeId


@pytest.mark.asyncio
async def test_project_must_already_be_published_before_git_mutation(tmp_path, monkeypatch) -> None:
    project = Project(id=mint_uuid(), remote=False, fs_storage_mount_path=str(tmp_path))
    agent = Agent(
        id=mint_uuid(),
        name="Q",
        project_id=project.id,
        asset_ref=str(tmp_path / "agent" / "q" / "agent.md"),
    )
    monkeypatch.setattr("flow_sdk.assets._publish_service.owning_project", AsyncMock(return_value=project))
    resolve = Mock()
    monkeypatch.setattr("flow_sdk.assets._publish_service.AssetGitWorktree.resolve", resolve)

    with pytest.raises(AssetPublishError) as raised:
        await publish_git_asset(agent, TypeId(type="user", id=mint_uuid()))
    assert raised.value.code is AssetPublishCode.PROJECT_NOT_PUBLISHED
    resolve.assert_not_called()


@pytest.mark.asyncio
async def test_publish_sends_project_id_only_and_updates_only_asset_cache(tmp_path, monkeypatch) -> None:
    actor = TypeId(type="user", id=mint_uuid())
    project = Project(
        id=mint_uuid(),
        name="flowpad-os",
        remote=True,
        fs_storage_mount_path=str(tmp_path),
        hub_published_at="already-published",
    )
    agent_dir = tmp_path / "agentic-assets" / "agent" / "q"
    agent_dir.mkdir(parents=True)
    agent_ref = agent_dir / "agent.md"
    agent_ref.write_text("Q\n", encoding="utf-8")
    agent = Agent(
        id=mint_uuid(),
        name="Q",
        title="QA manager",
        project_id=project.id,
        asset_ref=str(agent_ref),
    )
    origin = PortableGitOrigin(
        provider="github",
        owner="flowpad",
        name="flowpad-os",
        branch="main",
        head_commit="a" * 40,
        rel_path="agentic-assets/agent/q",
    )
    receipt = AssetGitReceipt(
        changed=True,
        repo_root=tmp_path,
        branch="main",
        head_commit="a" * 40,
        origin=origin,
    )
    projection = PortableAssetProjection(
        type="agent",
        id=agent.id,
        fields={"name": "Q", "title": "QA manager"},
        layout=PortableAssetLayout(
            asset_rel_root="agentic-assets/agent/q",
            main_ref="agent.md",
        ),
    )
    worktree = SimpleNamespace(repo_root=tmp_path, publish=AsyncMock(return_value=receipt))
    project_before = project.model_dump(mode="json")
    posted: dict = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, path, payload):
            posted.update({"path": path, "payload": payload})
            return {"asset": {"id": agent.id, "type": "agent"}}

    monkeypatch.setattr("flow_sdk.assets._publish_service.owning_project", AsyncMock(return_value=project))
    monkeypatch.setattr("flow_sdk.assets._publish_service.AssetGitWorktree.resolve", lambda _: worktree)
    monkeypatch.setattr("flow_sdk.assets._publish_service.project_asset_tree", lambda **_: projection)
    monkeypatch.setattr(
        "flow_sdk.assets._publish_service._actor_author",
        AsyncMock(return_value=GitAuthor(name="Q", email="q@example.com", typeid=str(actor))),
    )
    monkeypatch.setattr("flow_sdk.core.oauth.github_credentials.get_github_token", AsyncMock(return_value="secret"))
    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda: SimpleNamespace(api_key="hub-key"),
    )
    monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient", FakeClient)
    save = AsyncMock(return_value=agent)
    monkeypatch.setattr(Agent, "save", save)

    result = await publish_git_asset(agent, actor)

    assert posted["path"] == "/graph/project/publish_asset"
    assert posted["payload"]["project"] == {"id": project.id}
    assert set(posted["payload"]) == {"contract_version", "project", "asset", "git_origin"}
    assert project.model_dump(mode="json") == project_before
    assert agent.remote is True
    assert agent.git_origin == origin.model_dump(mode="json")
    save.assert_awaited_once_with(actor, notify=False)
    assert result.project == {"id": project.id}
