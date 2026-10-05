"""The Automations REST surface on ``Trigger`` — status codes that say what went wrong, and
*Run once now* answering the same shape for every kind."""

from __future__ import annotations

import uuid

import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]  # do not increase timeout without approval


def _name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _create(client, **body) -> dict:
    resp = await client.post("/api/v1/graph/trigger/create", json={"name": _name("api-auto"), **body})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


async def test_create_without_a_name_is_422(bootstrapped_client):
    client = bootstrapped_client
    resp = await client.post("/api/v1/graph/trigger/create", json={"trigger_type": "tag"})
    assert resp.status_code == 422, resp.text


async def test_create_with_a_match_everything_pattern_is_422(bootstrapped_client):
    client = bootstrapped_client
    resp = await client.post("/api/v1/graph/trigger/create",
                             json={"name": _name("bad"), "trigger_type": "tag", "tag_pattern": "*"})
    assert resp.status_code == 422
    assert "EVERY event" in resp.json()["message"]


async def test_rule_code_of_an_event_rule_is_404_not_500(bootstrapped_client):
    client = bootstrapped_client
    row = await _create(client, trigger_type="tag", tag_pattern="apitest.*")
    resp = await client.get(f"/api/v1/graph/trigger/{row['id']}/trigger-content")
    assert resp.status_code == 404
    assert "no rule code" in resp.json()["message"]


async def test_run_once_on_a_disabled_event_rule_starts(bootstrapped_client):
    client = bootstrapped_client
    row = await _create(client, trigger_type="tag", tag_pattern="apitest.*", enabled=False)
    resp = await client.post(f"/api/v1/graph/trigger/{row['id']}/test",
                             json={"event": {"tag": "apitest.pick", "target": "task:t-1"}})
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["trigger_id"] == row["id"] and data["event_id"]
    assert data["detail"] == {"tag": "apitest.pick", "target": "task:t-1"}


async def test_run_once_refusal_is_422_with_the_fix(bootstrapped_client):
    client = bootstrapped_client
    row = await _create(client, trigger_type="fsop")
    resp = await client.post(f"/api/v1/graph/trigger/{row['id']}/test", json={})
    assert resp.status_code == 422
    assert "watches no file" in resp.json()["message"]
