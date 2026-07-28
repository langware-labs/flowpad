from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.wiki import Wiki
from flow_sdk.cloud_client import wiki_cache
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.fs_record import FSRecord

pytestmark = pytest.mark.asyncio


async def test_hub_wiki_bridge_uses_canonical_graph_calls_and_caches_metadata(
    bootstrapped_client,
    monkeypatch,
):
    wiki_id = mint_uuid()
    target_id = mint_uuid()
    creator_id = mint_uuid()
    calls: list[tuple[BuiltinEntityType, str | None, str | None, dict | None]] = []

    async def fake_hub_get(
        entity_type,
        entity_id=None,
        action=None,
        sub_path=None,
        *,
        params=None,
        **_kwargs,
    ):
        assert sub_path is None
        calls.append((entity_type, entity_id, action, params))
        if entity_type == BuiltinEntityType.WIKI and entity_id == wiki_id and action is None:
            return {
                "id": wiki_id,
                "type": "wiki",
                "name": "Hub Wiki",
                "project_id": mint_uuid(),
                "created_by": creator_id,
            }
        if entity_type == BuiltinEntityType.WIKI and entity_id == wiki_id and action == "resolve":
            return {
                "kind": "resolved",
                "target_typeid": f"markdown-{target_id}",
                "source": "implicit",
            }
        if entity_type == BuiltinEntityType.MARKDOWN and entity_id == target_id:
            return {
                "id": target_id,
                "type": "markdown",
                "name": "HubFileWiki",
                "title": "Hub File Wiki",
                "asset_ref": "/sender/private/docs/HubFileWiki.md",
                "project_id": mint_uuid(),
                "created_by": creator_id,
            }
        raise AssertionError((entity_type, entity_id, action, params))

    monkeypatch.setattr(wiki_cache, "hub_get", fake_hub_get)

    response = await bootstrapped_client.get(
        f"/api/v1/cloud/wiki/{wiki_id}/resolve",
        params={"word": "HubFileWiki"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["data"] == {
        "kind": "resolved",
        "target_typeid": f"markdown-{target_id}",
        "source": "implicit",
    }
    assert calls == [
        (BuiltinEntityType.WIKI, wiki_id, None, None),
        (BuiltinEntityType.WIKI, wiki_id, "resolve", {"word": "HubFileWiki"}),
        (BuiltinEntityType.MARKDOWN, target_id, None, None),
    ]

    cached_wiki = await Wiki.get_by_id(wiki_id)
    cached_target = await Docs.get_by_id(target_id)
    assert cached_wiki is not None and cached_wiki.remote is True
    assert cached_target is not None and cached_target.remote is True
    assert cached_target.asset_ref == ""
    assert FSRecord.load_or_none("markdown", target_id) is None


async def test_hub_wiki_bridge_preserves_existing_local_placement(
    bootstrapped_client,
    monkeypatch,
    tmp_path,
):
    wiki_id = mint_uuid()
    target_id = mint_uuid()
    creator_id = mint_uuid()
    local_path = tmp_path / "local-source.md"
    local = Docs(
        id=target_id,
        name="Old Name",
        title="Old title",
        asset_ref=str(local_path),
    )
    await local.save()

    async def fake_hub_get(entity_type, entity_id=None, action=None, **_kwargs):
        if entity_type == BuiltinEntityType.WIKI and action is None:
            return {
                "id": wiki_id,
                "type": "wiki",
                "name": "Hub Wiki",
                "created_by": creator_id,
            }
        if entity_type == BuiltinEntityType.WIKI and action == "resolve":
            return {
                "kind": "resolved",
                "target_typeid": f"markdown-{target_id}",
                "source": "entry",
            }
        return {
            "id": target_id,
            "type": "markdown",
            "name": "Hub Name",
            "title": "Hub title",
            "asset_ref": "/sender/path.md",
            "created_by": creator_id,
        }

    monkeypatch.setattr(wiki_cache, "hub_get", fake_hub_get)

    response = await bootstrapped_client.get(
        f"/api/v1/cloud/wiki/{wiki_id}/resolve",
        params={"word": "Hub Name"},
    )

    assert response.status_code == 200, response.text
    refreshed = await Docs.get_by_id(target_id)
    assert refreshed is not None
    assert refreshed.remote is True
    assert refreshed.name == "Hub Name"
    assert refreshed.asset_ref == str(local_path)
