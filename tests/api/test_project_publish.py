from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from flow_sdk.builtin.project import Project

ORIGIN = {
    "kind": "git",
    "provider": "github",
    "owner": "flowpad-test",
    "name": "published-project",
    "branch": "main",
    "head_commit": "a" * 40,
    "rel_path": ".",
}
PUBLISHED_AT = "2026-08-03T12:00:00+00:00"
CANONICAL_ORIGIN = {**ORIGIN, "project_id": ""}


async def _create_project(client, tmp_path, name: str) -> dict:
    response = await client.post(
        "/api/v1/graph/project",
        json={
            "type": "project",
            "name": name,
            "fs_storage_mount_path": str(tmp_path / name),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


@pytest.mark.asyncio
async def test_project_publish_requires_current_users_github_oauth(
    bootstrapped_client,
    tmp_path,
    monkeypatch,
) -> None:
    project = await _create_project(bootstrapped_client, tmp_path, "publish-oauth-gate")
    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda: SimpleNamespace(api_key="hub-key"),
    )
    github_token = AsyncMock(return_value=None)
    monkeypatch.setattr("flow_sdk.core.oauth.github_credentials.get_github_token", github_token)
    preflight = AsyncMock()
    monkeypatch.setattr(
        "flow_sdk.app.actions.git_share_preflight_action.git_share_preflight",
        preflight,
    )
    publish = AsyncMock()
    monkeypatch.setattr(Project, "share", publish)

    response = await bootstrapped_client.post(
        f"/api/v1/graph/project/{project['id']}/share",
        json={},
    )

    assert response.status_code == 409
    assert response.json()["data"]["code"] == "github_not_connected"
    github_token.assert_awaited_once()
    preflight.assert_not_awaited()
    publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_project_publish_returns_preflight_code_without_calling_hub(
    bootstrapped_client,
    tmp_path,
    monkeypatch,
) -> None:
    project = await _create_project(bootstrapped_client, tmp_path, "publish-preflight-gate")
    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda: SimpleNamespace(api_key="hub-key"),
    )
    monkeypatch.setattr(
        "flow_sdk.core.oauth.github_credentials.get_github_token",
        AsyncMock(return_value="github-token"),
    )
    monkeypatch.setattr(
        "flow_sdk.app.actions.git_share_preflight_action.git_share_preflight",
        AsyncMock(
            return_value={
                "available": False,
                "reason": "The repository has uncommitted changes.",
                "code": "dirty",
                "git_origin": ORIGIN,
            }
        ),
    )
    publish = AsyncMock()
    monkeypatch.setattr(Project, "share", publish)

    response = await bootstrapped_client.post(
        f"/api/v1/graph/project/{project['id']}/share",
        json={},
    )

    assert response.status_code == 409
    assert response.json()["data"] == {
        "code": "dirty",
        "reason": "The repository has uncommitted changes.",
        "git_origin": ORIGIN,
    }
    publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_project_publish_returns_and_persists_canonical_project(
    bootstrapped_client,
    tmp_path,
    monkeypatch,
) -> None:
    project = await _create_project(bootstrapped_client, tmp_path, "publish-canonical")
    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda: SimpleNamespace(api_key="hub-key"),
    )
    monkeypatch.setattr(
        "flow_sdk.core.oauth.github_credentials.get_github_token",
        AsyncMock(return_value="github-token"),
    )
    monkeypatch.setattr(
        "flow_sdk.app.actions.git_share_preflight_action.git_share_preflight",
        AsyncMock(
            return_value={
                "available": True,
                "reason": None,
                "code": None,
                "git_origin": ORIGIN,
            }
        ),
    )

    async def _publish(self: Project, recipients=None) -> Project:  # noqa: ARG001
        self.remote = True
        self.hub_published_at = PUBLISHED_AT
        return self

    monkeypatch.setattr(Project, "share", _publish)

    response = await bootstrapped_client.post(
        f"/api/v1/graph/project/{project['id']}/share",
        json={},
    )

    assert response.status_code == 200, response.text
    canonical = response.json()["data"]
    assert canonical["id"] == project["id"]
    assert canonical["remote"] is True
    assert canonical["hub_published_at"] == PUBLISHED_AT
    assert canonical["git_origin"] == CANONICAL_ORIGIN

    persisted = await Project._db.get_by_id(project["id"], Project.get_type())
    assert persisted is not None
    assert persisted.remote is True
    assert persisted.hub_published_at == PUBLISHED_AT
    assert persisted.git_origin.model_dump(mode="json") == CANONICAL_ORIGIN
