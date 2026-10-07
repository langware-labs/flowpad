"""``POST /api/v1/data_source/<source id>/webhook`` — an event a hub webhook claim routed to ONE channel.

The hub checked the vendor's signature at its edge and cut the batch into one event per message, so the
event reaches its channel by id, with no vendor signature to check here; a channel that is not on this
instance answers 404 (the hub counts a misroute, never a delivery). Flow on WhatsApp is the channel: the
person's message and Flow's answer (``x-flowpad-chain-direction: out``) both land in its items.
"""
from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.ingest.testing import make_data_source

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

PHONE = "972500000001"


def _meta(message: dict) -> bytes:
    value = {"metadata": {"phone_number_id": "PNID"}, "contacts": [{"wa_id": PHONE, "profile": {"name": "Dana"}}], "messages": [message]}
    return json.dumps({"object": "whatsapp_business_account", "entry": [{"changes": [{"value": value}]}]}).encode()


async def _flow_channel() -> DataSource:
    for leftover in await DataSource.get_all({"provider": "flow_whatsapp"}):
        await leftover.delete()
    source = make_data_source(
        "flow_whatsapp",
        name=f"flow {uuid.uuid4().hex[:6]}",
        config={"link_id": "L1", "wa_id": PHONE},
        status=SourceStatus.ACTIVE.value,
        allowed_senders=[PHONE],
    )
    await source.save()
    return source


async def test_a_hub_delivered_message_and_flows_answer_land_in_the_channel(bootstrapped_client):
    source = await _flow_channel()
    try:
        asked = await bootstrapped_client.post(
            f"/api/v1/data_source/{source.id}/webhook",
            content=_meta({"from": PHONE, "id": "wamid.IN1", "timestamp": "100", "type": "text", "text": {"body": "hi Flow"}}),
            headers={"content-type": "application/json", "x-flowpad-chain-event": "wamid.IN1"},
        )
        answered = await bootstrapped_client.post(
            f"/api/v1/data_source/{source.id}/webhook",
            content=_meta(
                {"to": PHONE, "id": "wamid.OUT1", "timestamp": "101", "type": "text", "text": {"body": "hello"}, "context": {"id": "wamid.IN1"}}
            ),
            headers={"content-type": "application/json", "x-flowpad-chain-direction": "out"},
        )
        again = await bootstrapped_client.post(
            f"/api/v1/data_source/{source.id}/webhook",
            content=_meta({"from": PHONE, "id": "wamid.IN1", "timestamp": "100", "type": "text", "text": {"body": "hi Flow"}}),
            headers={"content-type": "application/json"},
        )

        assert asked.status_code == 200 and asked.json()["data"]["created"] == 1, asked.text
        assert answered.status_code == 200 and answered.json()["data"]["created"] == 1, answered.text
        assert again.status_code == 200 and again.json()["data"]["created"] == 0, "the same message is one item"
        assert again.json()["data"]["ids"] == asked.json()["data"]["ids"]
    finally:
        await source.delete()


async def test_a_channel_that_is_not_here_is_a_404_the_hub_counts_as_a_misroute(bootstrapped_client):
    missing = await bootstrapped_client.post(
        f"/api/v1/data_source/{uuid.uuid4()}/webhook", content=b"{}", headers={"content-type": "application/json"}
    )
    assert missing.status_code == 404
