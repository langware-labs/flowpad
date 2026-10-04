"""``DELETE /graph/<type>/<id>`` answers whether it deleted, even when the entity's own delete
answers what it removed: an Agent's delete returns the ids of the rows it took with it, and the
route used to hand that list to a bool-typed response — a 500 on every agent delete."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_deleting_an_agent_answers_success(bootstrapped_client, user):
    created = await bootstrapped_client.post(
        "/api/v1/graph/agent", json={"name": "delete me", "worker_type": "claude", "system_prompt": "Be brief."}
    )
    assert created.json().get("status") == "SUCCESS", created.text
    agent_id = created.json()["data"]["id"]

    resp = await bootstrapped_client.delete(f"/api/v1/graph/agent/{agent_id}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "SUCCESS" and resp.json()["data"] is True
