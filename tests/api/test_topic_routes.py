"""Generic graph CRUD for the Topic entity + the reserved-root API gate.

Topics have NO bespoke routes — everything goes through the catch-all
``/api/v1/graph/topic`` router (api_visible type). The reserved-root policy is
save-validation on the entity, so it must surface as a 4xx here, never a 500.
"""

import pytest

pytestmark = pytest.mark.asyncio


async def test_topic_generic_crud_roundtrip(client):
    created = await client.post(
        "/api/v1/graph/topic",
        json={"name": "--acme--.orders.created", "description": "An order was placed"},
    )
    assert created.status_code == 200, created.text
    body = created.json()["data"]
    topic_id = body["id"]

    # uuid5-of-name: re-creating the same name converges on the same id.
    again = await client.post(
        "/api/v1/graph/topic", json={"name": "--acme--.orders.created"})
    assert again.status_code == 200
    assert again.json()["data"]["id"] == topic_id

    listed = (await client.get("/api/v1/graph/topic")).json()["data"]
    assert any(t["id"] == topic_id for t in listed)


async def test_topic_reserved_root_rejected_via_api(client):
    resp = await client.post("/api/v1/graph/topic", json={"name": "flow.hacked"})
    assert 400 <= resp.status_code < 500, resp.text

    resp = await client.post("/api/v1/graph/topic", json={"name": "not a topic!"})
    assert 400 <= resp.status_code < 500, resp.text


async def test_topic_system_flag_is_not_client_assertable(client):
    # `system` is server-derived (EntityField, not an API field): the create
    # sanitizer drops it, so it cannot defeat the reserved-root gate...
    resp = await client.post(
        "/api/v1/graph/topic", json={"name": "flow.spoofed", "system": True})
    assert 400 <= resp.status_code < 500, resp.text

    # ...and on a permitted name it silently lands as a plain user topic.
    resp = await client.post(
        "/api/v1/graph/topic", json={"name": "--spoof--.attempt", "system": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["system"] is False
