"""Message-tag wire contracts, using the real router and database."""

import asyncio

import pytest

from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.api.api_types.identifier import mint_uuid

pytestmark = pytest.mark.asyncio


async def test_message_tag_actions_share_persisted_provenance(client):
    message = await FlowMessage(text="Please review my refund").save()
    url = f"/api/v1/graph/flow_message/{message.id}"

    added = await client.post(f"{url}/tags/customer.refund")
    assert added.status_code == 200, added.text
    stored = await FlowMessage.get_by_id(message.id)
    assert stored.tags == ["customer.refund"]
    assert stored.message_processing.assignments["customer.refund"].source == "manual"

    changed = await client.post(f"{url}/set-tags", json={"tags": ["customer.review"]})
    assert changed.status_code == 200, changed.text
    assert changed.json()["data"]["tags"] == ["customer.review"]
    removed = await client.delete(f"{url}/tags/customer.review")
    assert removed.status_code == 200, removed.text
    stored = await FlowMessage.get_by_id(message.id)
    assert stored.tags == []
    assert stored.message_processing.assignments == {}
    assert {"customer.refund", "customer.review"} <= set(stored.message_processing.suppressed_tags)


async def test_classification_settings_roundtrip_and_invalid_input(client):
    url = "/api/v1/graph/flow_message/classification-settings"
    before = await client.get(url)
    assert before.status_code == 200, before.text
    original = before.json()["data"]
    try:
        changed = await client.post(url, json={"enabled": False, "include_flow_tags": True})
        assert changed.status_code == 200, changed.text
        saved = (await client.get(url)).json()["data"]
        assert saved["enabled"] is False
        assert saved["include_flow_tags"] is True
        invalid = await client.post(url, json={"enabled": {"invalid": True}})
        assert 400 <= invalid.status_code < 500, invalid.text
    finally:
        await client.post(url, json=original)


async def test_inbox_tag_uses_generic_crud_with_color(client):
    created = await client.post("/api/v1/graph/tag", json={
        "name": "--message-api--.refund", "title": "Refund", "color": "#7c3aed", "inbox": True,
    })
    assert created.status_code == 200, created.text
    tag_id = created.json()["data"]["id"]
    found = await client.get(f"/api/v1/graph/tag/{tag_id}")
    assert found.status_code == 200, found.text
    assert found.json()["data"]["color"] == "#7c3aed"
    assert found.json()["data"]["inbox"] is True


async def test_generic_update_cannot_forge_processing_state(client):
    message = await FlowMessage(text="A processing claim is server-owned").save()
    url = f"/api/v1/graph/flow_message/{message.id}"
    response = await client.put(url, json={"message_processing": {
        "classification": "succeeded", "assignments": {
            "customer.refund": {"source": "automation", "trigger_id": "forged"},
        },
    }})
    assert response.status_code < 500, response.text
    stored = await FlowMessage.get_by_id(message.id)
    assert stored.message_processing is None or stored.message_processing.classification != "succeeded"


async def test_generic_message_create_and_update_use_tag_mutation(client):
    forged = {"classification": "succeeded"}
    created = await client.post("/api/v1/graph/flow_message", json={
        "text": "Created through the generic SDK", "tags": ["customer.refund"],
        "message_processing": forged,
    })
    assert created.status_code == 200, created.text
    message_id = created.json()["data"]["id"]
    stored = await FlowMessage.get_by_id(message_id)
    assert stored.message_processing.classification != "succeeded"
    assert stored.message_processing.assignments["customer.refund"].source == "manual"
    updated = await client.put(f"/api/v1/graph/flow_message/{message_id}", json={
        "tags": ["customer.review"], "message_processing": forged,
    })
    assert updated.status_code == 200, updated.text
    stored = await FlowMessage.get_by_id(message_id)
    assert stored.tags == ["customer.review"]
    assert stored.message_processing.assignments["customer.review"].source == "manual"
    assert "customer.refund" in stored.message_processing.suppressed_tags


async def test_concurrent_message_tag_actions_do_not_lose_assignments(client):
    message = await FlowMessage(text="Two people tag the same message").save()
    url = f"/api/v1/graph/flow_message/{message.id}/tags"
    replies = await asyncio.gather(
        client.post(f"{url}/customer.refund"), client.post(f"{url}/customer.review"),
    )
    assert all(reply.status_code == 200 for reply in replies), [reply.text for reply in replies]
    stored = await FlowMessage.get_by_id(message.id)
    assert set(stored.tags) == {"customer.refund", "customer.review"}
    assert set(stored.message_processing.assignments) == set(stored.tags)


async def test_inbox_tag_filter_matches_hierarchy_and_the_same_message_as_text(client):
    matching, other = mint_uuid(), mint_uuid()
    await FlowMessage(text="Refund approved", conversation_id=matching, tags=["customer.refund"]).save()
    await FlowMessage(text="Different subject", conversation_id=other, tags=["customer.refund"]).save()
    await FlowMessage(text="Refund approved", conversation_id=other, tags=["customer.other"]).save()
    url = "/api/v1/graph/stream-inbox-search"
    by_tag = await client.post(url, json={"tags": ["customer.refund"]})
    assert by_tag.status_code == 200, by_tag.text
    assert {matching, other} <= set(by_tag.json()["data"]["conversation_ids"])
    both = await client.post(url, json={"q": "Refund approved", "tags": ["customer.refund"]})
    assert both.status_code == 200, both.text
    assert both.json()["data"]["conversation_ids"] == [matching]
    parent = await client.post(url, json={"tags": ["customer"]})
    assert {matching, other} <= set(parent.json()["data"]["conversation_ids"])


async def test_automation_message_tags_survive_create_update_and_reload(bootstrapped_client):
    client = bootstrapped_client
    created = await client.post("/api/v1/graph/trigger/create", json={
        "name": f"Message tags wire {mint_uuid()}", "trigger_type": "tag",
        "tag_pattern": "channel.*.message", "message_tags": ["customer.refund"],
    })
    assert created.status_code == 200, created.text
    rule = created.json()["data"]
    assert rule["message_tags"] == ["customer.refund"]
    url = f"/api/v1/graph/trigger/{rule['id']}"
    updated = await client.patch(f"{url}/update", json={
        "message_tags": ["customer.review", "customer.refund"],
    })
    assert updated.status_code == 200, updated.text
    found = await client.get(url)
    assert found.status_code == 200, found.text
    assert found.json()["data"]["message_tags"] == ["customer.review", "customer.refund"]


async def test_inbox_tag_management_actions_preserve_associations_and_delete_attachments(bootstrapped_client):
    client = bootstrapped_client
    name = f"qa.api.{str(mint_uuid()).replace('-', '')}"
    created = await client.post("/api/v1/graph/tag", json={"name": name, "inbox": True})
    assert created.status_code == 200, created.text
    tag_id = created.json()["data"]["id"]
    message = await FlowMessage(text="Keep this message", tags=[name]).save()
    rule_response = await client.post("/api/v1/graph/trigger/create", json={
        "name": f"Wire management {mint_uuid()}", "trigger_type": "tag",
        "tag_pattern": "channel.*.message", "message_tags": [name],
    })
    assert rule_response.status_code == 200, rule_response.text
    rule_id = rule_response.json()["data"]["id"]
    url = f"/api/v1/graph/tag/{tag_id}"
    impact = await client.get(f"{url}/message-tag-impact")
    assert impact.status_code == 200, impact.text
    assert impact.json()["data"] == {"messages": 1, "automations": 1}

    renamed = await client.post(f"{url}/rename-message-tag", json={
        "name": f"{name}.renamed", "title": "Renamed", "color": "#2563eb",
    })
    assert renamed.status_code == 200, renamed.text
    successor = renamed.json()["data"]["tag"]
    assert successor["color"] == "#2563eb"
    old = (await client.get(url)).json()["data"]
    assert old["deprecated"] and old["alias_of"] == successor["name"]
    assert (await FlowMessage.get_by_id(message.id)).tags == [successor["name"]]
    rule = (await client.get(f"/api/v1/graph/trigger/{rule_id}")).json()["data"]
    assert rule["message_tags"] == [successor["name"]]

    deleted = await client.post(f"/api/v1/graph/tag/{successor['id']}/delete-message-tag")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["data"] == {"messages": 1, "automations": 1}
    stored = await FlowMessage.get_by_id(message.id)
    assert stored.text == "Keep this message" and stored.tags == []
    rule = (await client.get(f"/api/v1/graph/trigger/{rule_id}")).json()["data"]
    assert rule["enabled"] is False
