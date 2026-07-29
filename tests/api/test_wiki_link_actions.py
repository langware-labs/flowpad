from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid

pytestmark = pytest.mark.asyncio
GRAPH = "/api/v1/graph"


async def test_wiki_action_owns_missing_target_contract(bootstrapped_client):
    missing_id = mint_uuid()
    base = f"{GRAPH}/skill/{missing_id}/wiki"

    links = await bootstrapped_client.get(f"{base}/links")
    assert links.status_code == 200, links.text
    assert links.json()["data"] == []

    indexed = await bootstrapped_client.post(
        f"{base}/reindex",
        json={"body": "See [[ghost target]]."},
    )
    assert indexed.status_code == 200, indexed.text
    assert [edge["raw"] for edge in indexed.json()["data"]] == ["ghost target"]

    reread = await bootstrapped_client.get(f"{base}/links")
    assert reread.status_code == 200, reread.text
    assert [edge["raw"] for edge in reread.json()["data"]] == ["ghost target"]
