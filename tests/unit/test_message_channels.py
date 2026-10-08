"""``GET data_source/channels`` — every MessageChannel and where its messages arrive.

A MessageChannel is a message source (a DataSource on a channel whose driver sends and receives). The hub is the only
place claims live, so the list joins the caller's hub claims (``webhook/mine``) to the sources here by the channel
each claim targets — stood in for here, the join is what is pinned.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin import data_source as data_source_module
from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.ingest.testing import make_data_source

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval

HERE = "11111111-2222-4333-8444-555555555555"


async def _channel(provider: str, **config) -> DataSource:
    source = make_data_source(provider, name=f"{provider} {uuid.uuid4().hex[:6]}", config=config, status=SourceStatus.ACTIVE.value)
    await source.save()
    return source


def _claim(source_id: str, *, instance: str = HERE, key: str = "972500000001", status: str = "active") -> dict:
    return {
        "id": f"wh-{uuid.uuid4().hex[:6]}",
        "provider": "whatsapp",
        "status": status,
        "claim": {"kind": "user", "key": key},
        "target": {"kind": "desktop", "instance_id": instance, "data_source_id": source_id},
        "deliveries": 3,
        "misroutes": 0,
        "recent": [],
        "url": "https://hub.test/webhook/x",
    }


async def test_each_channel_says_where_its_messages_arrive(monkeypatch):
    from flow_sdk.instance_settings import runtime

    here = await _channel("flow_whatsapp", claim_id="C1", wa_id="972500000001")
    polled = await _channel("flow_telegram", claim_id="C9", sender="5550001")
    elsewhere = _claim("not-on-this-instance", instance="99999999-2222-4333-8444-555555555555", key="972500000002")
    claims = [_claim(str(here.id)), elsewhere, {"id": "root", "claim": {"kind": "root"}, "target": {"kind": "none"}}]

    async def hub_claims():
        return claims

    monkeypatch.setattr(data_source_module, "_hub_claims", hub_claims)
    monkeypatch.setattr(runtime, "instance_uid", lambda: HERE)
    try:
        resp = await DataSource.channels_action(DataSource)
        rows = {r["source_id"] or r["claim"]["id"]: r for r in resp.data["channels"]}

        assert rows[str(here.id)]["routed"] == "this" and rows[str(here.id)]["claim"]["deliveries"] == 3
        assert rows[str(polled.id)]["routed"] == "unclaimed" and rows[str(polled.id)]["claim"] is None, (
            "a channel that receives only through a claim and has none needs Connect"
        )
        assert rows[elsewhere["id"]]["routed"] == "instance" and rows[elsewhere["id"]]["source_id"] == ""
        assert "root" not in rows, "the vendor's root is not anyone's channel"
    finally:
        await here.delete()
        await polled.delete()
