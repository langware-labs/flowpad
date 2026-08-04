from __future__ import annotations

from unittest.mock import AsyncMock

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
    publish = AsyncMock(
        return_value=AssetPublishResult(
            project={"id": "project-id"},
            asset={"id": agent["id"], "name": agent["name"]},
            git={"changed": False},
        )
    )
    monkeypatch.setattr("flow_sdk.app.actions.share_action._local_mode_share_blocked", lambda: False)
    monkeypatch.setattr("flow_sdk.assets.git_publish.publish_git_asset", publish)

    response = await bootstrapped_client.post(
        f"/api/v1/graph/agent/{agent['id']}/share",
        json={"id": "forged", "name": "forged", "system_prompt": "forged"},
    )
    assert response.status_code == 200, response.text
    published_entity = publish.await_args.args[0]
    assert published_entity.id == agent["id"]
    assert published_entity.name == agent["name"]
    assert published_entity.system_prompt == "Run QA."


@pytest.mark.asyncio
async def test_git_asset_share_rejects_recipients_and_missing_url_row(
    bootstrapped_client,
    monkeypatch,
) -> None:
    agent = await _create_agent(bootstrapped_client, "Q-share-no-recipients")
    monkeypatch.setattr("flow_sdk.app.actions.share_action._local_mode_share_blocked", lambda: False)
    publish = AsyncMock()
    monkeypatch.setattr("flow_sdk.assets.git_publish.publish_git_asset", publish)

    response = await bootstrapped_client.post(
        f"/api/v1/graph/agent/{agent['id']}/share",
        json={"recipients": ["qa@example.com"]},
    )
    assert response.status_code == 400
    assert response.json()["data"]["code"] == "asset_recipients_not_allowed"
    publish.assert_not_awaited()

    missing = await bootstrapped_client.post(
        "/api/v1/graph/agent/8efbd5c2-e780-4a75-b890-a6bca8c1e9f4/share",
        json={},
    )
    assert missing.status_code == 404
