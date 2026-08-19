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
    resolve = AsyncMock()
    monkeypatch.setattr("flow_sdk.assets._publish_service.resolve_asset_folder", resolve)

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
    folder = SimpleNamespace(root=tmp_path)
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
    monkeypatch.setattr("flow_sdk.assets._publish_service.resolve_asset_folder", AsyncMock(return_value=folder))
    monkeypatch.setattr("flow_sdk.assets._publish_service.publish_asset", AsyncMock(return_value=receipt))
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


# ── the failure table: status AND remedy, in one place ───────────────────


def test_every_publish_code_has_a_status_and_a_remedy():
    """A code with no row falls back to 500 and says nothing.

    The table exists because two call sites — sharing an asset and deploying an
    agent — answer the same question, and a second copy drifts. A new code added
    without a row would silently become a server error with no guidance, which is
    the state this replaced.
    """
    from flow_sdk.assets.git_publish import (
        AssetPublishCode,
        publish_failure_remedy,
        publish_failure_status,
    )

    for code in AssetPublishCode:
        assert publish_failure_status(code) != 500, f"{code} has no status row"
        assert publish_failure_remedy(code), f"{code} tells the reader nothing to do"


def test_a_precondition_is_a_client_status_not_a_server_fault():
    """These are the caller's state. Reporting them as 500 both mislabels them in
    logs and, on the wire, loses the sentence that says what to do."""
    from flow_sdk.assets.git_publish import AssetPublishCode, publish_failure_status

    assert publish_failure_status(AssetPublishCode.NOT_GIT_BACKED) == 400
    assert publish_failure_status(AssetPublishCode.GITHUB_NOT_CONNECTED) == 409
    # A push the remote refused is genuinely upstream, not the caller.
    assert publish_failure_status(AssetPublishCode.PUSH_REJECTED) == 502


def test_actionable_carries_the_failure_and_the_remedy():
    from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError

    exc = AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset has no owning Project")

    assert "Asset has no owning Project" in exc.actionable
    # The half that was missing: the reader was told the problem and left stuck.
    assert "inside a project" in exc.actionable
