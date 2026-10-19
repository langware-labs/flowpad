"""Sharing a file-backed asset through the generic ``share`` action publishes it
into its project's hub repo (``publish_git_asset``) — the entity loaded from the
URL, never the request body. The hub round trip is recorded in its place."""
from __future__ import annotations

import pytest

from flow_sdk.assets.git_publish import AssetPublishResult


async def _create_agent(client, name: str) -> dict:
    response = await client.post(
        "/api/v1/graph/agent",
        json={"name": name, "title": "QA manager", "system_prompt": "Run QA."},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


@pytest.mark.asyncio
async def test_git_asset_share_loads_url_entity_and_ignores_forged_body(
    bootstrapped_client,
    monkeypatch,
) -> None:
    agent = await _create_agent(bootstrapped_client, "Q-share-authoritative")
    published: list = []

    async def publish(entity, actor):
        published.append(entity)
        return AssetPublishResult(
            project={"id": "project-id"},
            asset={"id": entity.id, "name": entity.name},
            git={"repo": "git_repo-" + "1" * 32, "rel_path": "agentic-assets/agent/q", "pushed": True},
        )

    monkeypatch.setattr("flow_sdk.app.actions.share_action._local_mode_share_blocked", lambda: False)
    monkeypatch.setattr("flow_sdk.builtin.asset_publishing.publish_git_asset", publish)

    response = await bootstrapped_client.post(
        f"/api/v1/graph/agent/{agent['id']}/share",
        json={"id": "forged", "name": "forged", "system_prompt": "forged"},
    )
    assert response.status_code == 200, response.text
    (published_entity,) = published
    assert published_entity.id == agent["id"]
    assert published_entity.name == agent["name"]
    assert published_entity.system_prompt == "Run QA."
    assert response.json()["data"]["git"]["repo"].startswith("git_repo-")


@pytest.mark.asyncio
async def test_git_asset_share_refusal_carries_code_and_remedy(bootstrapped_client, monkeypatch) -> None:
    from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError

    agent = await _create_agent(bootstrapped_client, "Q-share-conflict")

    async def conflict(entity, actor):
        raise AssetPublishError(AssetPublishCode.ASSET_CONFLICT, "changed on the hub and here", data={"rel_path": "q"})

    monkeypatch.setattr("flow_sdk.app.actions.share_action._local_mode_share_blocked", lambda: False)
    monkeypatch.setattr("flow_sdk.builtin.asset_publishing.publish_git_asset", conflict)

    response = await bootstrapped_client.post(f"/api/v1/graph/agent/{agent['id']}/share", json={})

    assert response.status_code == 409
    assert response.json()["data"] == {"code": "asset_conflict", "rel_path": "q"}
    assert "Keep one version" in response.json()["message"]


@pytest.mark.asyncio
async def test_git_asset_share_rejects_recipients_and_missing_url_row(
    bootstrapped_client,
    monkeypatch,
) -> None:
    agent = await _create_agent(bootstrapped_client, "Q-share-no-recipients")
    monkeypatch.setattr("flow_sdk.app.actions.share_action._local_mode_share_blocked", lambda: False)
    published: list = []

    async def publish(entity, actor):
        published.append(entity)

    monkeypatch.setattr("flow_sdk.builtin.asset_publishing.publish_git_asset", publish)

    response = await bootstrapped_client.post(
        f"/api/v1/graph/agent/{agent['id']}/share",
        json={"recipients": ["qa@example.com"]},
    )
    assert response.status_code == 400
    assert response.json()["data"]["code"] == "asset_recipients_not_allowed"
    assert published == []

    missing = await bootstrapped_client.post(
        "/api/v1/graph/agent/8efbd5c2-e780-4a75-b890-a6bca8c1e9f4/share",
        json={},
    )
    assert missing.status_code == 404
