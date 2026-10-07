"""The ``flow_telegram`` data source: one person's Telegram conversation with Flow, entirely through the hub.

Offline: the source is handed ``FakeFlowHub``. Connect, the gate and sending are ``FlowChannel``'s (pinned once, on
``flow_whatsapp``); what is pinned here is Telegram's own — the Update envelope both ways and the ids it keys on.
"""

from __future__ import annotations

import pytest

from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.testing.flow_hub import FakeFlowHub
from flow_sdk.sources.values.items import MessageData

module = asset_module("flow_telegram")
FlowTelegramSource = module.FlowTelegramSource

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ME = "5550001"
T_ME = "https://t.me/flow_test_bot"


def _Hub(**kw) -> FakeFlowHub:
    return FakeFlowHub(display="@flow_test_bot", deep_link=T_ME, **kw)


def _source(hub, **config) -> FlowTelegramSource:
    return FlowTelegramSource(SourceBinding(source_id="ds-tg", config=config), hub=hub)


def _update(text: str, *, sender: str = ME, message_id: int = 7, reply_to: int = 0, out: bool = False) -> dict:
    message = {
        "message_id": message_id,
        "from": {"id": 777000 if out else int(sender), "is_bot": out, "first_name": "Flow" if out else "Dana"},
        "chat": {"id": int(sender), "type": "private"},
        "date": 1700000000,
        "text": text,
    }
    if reply_to:
        message["reply_to_message"] = {"message_id": reply_to}
    return {"message": message, **({"flowpad_direction": "out"} if out else {})}


async def test_connect_asks_the_hub_about_telegram_and_shows_the_t_me_link():
    hub = _Hub()
    answer = await _source(hub)._connect(check=False, values={})
    assert answer.ok and answer.value.shown.link == f"{T_ME}?code=AB2CD3" and answer.value.shown.number == "@flow_test_bot"
    assert set(hub.channels) == {"telegram"}


async def test_the_gate_keeps_the_telegram_account():
    hub = _Hub()
    await hub.connect("telegram", {})
    source = _source(hub, link_id="L1")
    assert "send the message from your Telegram account" in (await source._connected(check=False, values={})).detail
    hub.connected("L1", ME)
    done = await source._connected(check=False, values={})
    assert done.ok and done.value.config == {"sender": ME} and done.value.allowed_senders == [ME]


async def test_an_update_and_flows_answer_become_items_keyed_as_the_hub_keys_them():
    async with _source(_Hub(), sender=ME) as source:
        (asked,) = [e.item for e in source.events_from_webhook(_update("hi"))]
        (answered,) = [e.item for e in source.events_from_webhook(_update("hello", message_id=8, reply_to=7, out=True))]
        other = source.events_from_webhook(_update("x", sender="5550002"))
    assert asked.origin.key == f"{ME}:7" and asked.data.sender.name == "Dana" and asked.data.conversation.key == ME
    assert answered.data.sender.name == "Flow" and answered.data.in_reply_to.key == f"{ME}:7"
    assert other == [], "only this source's own account"


async def test_a_reply_goes_to_the_persons_chat_quoting_the_message():
    hub = _Hub()
    async with _source(hub, sender=ME) as source:
        asked = source.message_origin(f"{ME}:7", ME)
        sent = await source.reply(asked, MessageData(text="Sure."))
    assert hub.sent == [(ME, "Sure.", f"{ME}:7")] and sent.data.in_reply_to == asked
