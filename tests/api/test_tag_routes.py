"""Generic graph CRUD for the Tag entity + the reserved-root API gate.

Tags have NO bespoke routes — everything goes through the catch-all
``/api/v1/graph/tag`` router (api_visible type). The reserved-root policy is
save-validation on the entity, so it must surface as a 4xx here, never a 500.
"""

import pytest

from flow_sdk.builtin.tag import Tag

pytestmark = pytest.mark.asyncio


async def test_tag_generic_crud_roundtrip(client):
    supplied_id = "11111111-2222-4333-8444-555555555555"
    created = await client.post(
        "/api/v1/graph/tag",
        json={
            "id": supplied_id,
            "name": "--acme--.orders.created",
            "description": "An order was placed",
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()["data"]
    tag_id = body["id"]
    assert tag_id == Tag(name="--acme--.orders.created").id
    assert tag_id != supplied_id
    assert body.get("uname") is None

    # uuid5-of-name: re-creating the same name converges on the same id.
    again = await client.post(
        "/api/v1/graph/tag", json={"name": "--acme--.orders.created"})
    assert again.status_code == 200
    assert again.json()["data"]["id"] == tag_id

    listed = (await client.get("/api/v1/graph/tag")).json()["data"]
    assert any(t["id"] == tag_id for t in listed)


async def test_tag_reserved_root_rejected_via_api(client):
    resp = await client.post("/api/v1/graph/tag", json={"name": "graph_workflow.hacked"})
    assert 400 <= resp.status_code < 500, resp.text

    resp = await client.post("/api/v1/graph/tag", json={"name": "not a tag!"})
    assert 400 <= resp.status_code < 500, resp.text


async def test_tag_system_flag_is_not_client_assertable(client):
    # `system` is server-derived (EntityField, not an API field): the create
    # sanitizer drops it, so it cannot defeat the reserved-root gate...
    resp = await client.post(
        "/api/v1/graph/tag", json={"name": "graph_workflow.spoofed", "system": True})
    assert 400 <= resp.status_code < 500, resp.text

    # ...and on a permitted name it silently lands as a plain user tag.
    resp = await client.post(
        "/api/v1/graph/tag", json={"name": "--spoof--.attempt", "system": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["system"] is False
