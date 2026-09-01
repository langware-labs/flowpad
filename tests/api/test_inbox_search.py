"""C5 — inbox-search finds bodies in both residences.

Under the reference model a channel message's body lives on its SourceItem
(the FlowMessage row is a blank reference) while a hub-native message's lives
on the row. The action must find both, and a reference row's stored ``text``
(always ``""``) must never false-match.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def _search(client, needle: str) -> list[str]:
    response = await client.post("/api/v1/graph/inbox-search", json={"q": needle})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "SUCCESS", body
    return body["data"]["conversation_ids"]


@pytest.mark.asyncio
async def test_search_hits_channel_bodies_and_native_text(bootstrapped_client):
    marker = uuid.uuid4().hex[:12]
    conv_channel, conv_native = str(uuid.uuid4()), str(uuid.uuid4())

    item = SourceItem(
        id=str(uuid.uuid4()),
        data_source_id=str(uuid.uuid4()),
        provider="agent",
        kind="content.message.chat",
        segment_key="C012345678",
        external_id="1725000000.000100",
        name="standup",
        body=f"deploy is blocked on {marker}-slack",
        author_external_id="U1",
    )
    await item.save(notify=False)
    ref = FlowMessage(
        id=str(uuid.uuid4()),
        conversation_id=conv_channel,
        text="",
        source_item_id=item.id,
    )
    await ref.save(notify=False)

    native = FlowMessage(
        id=str(uuid.uuid4()),
        conversation_id=conv_native,
        text=f"hub thread mentioning {marker}-native",
    )
    await native.save(notify=False)

    assert await _search(bootstrapped_client, f"{marker}-slack") == [conv_channel]
    assert await _search(bootstrapped_client, f"{marker}-native") == [conv_native]
    both = await _search(bootstrapped_client, marker)
    assert set(both) == {conv_channel, conv_native}
    assert await _search(bootstrapped_client, f"{marker}-nothing") == []


@pytest.mark.asyncio
async def test_blank_query_matches_nothing_rather_than_everything(bootstrapped_client):
    assert await _search(bootstrapped_client, "   ") == []
