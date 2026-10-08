"""The ``flow_telegram`` data source: one person's Telegram conversation on Flowpad's bot, through the hub's chain.

Offline: the source is handed ``FakeFlowHub``. Connect, the gate and replying are ``FlowChannel``'s (pinned once, on
``flow_whatsapp``); what is pinned here is Telegram's own — the Update envelope and the ids it keys on.
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
    return FakeFlowHub(deep_link=T_ME, **kw)


def _source(hub, **config) -> FlowTelegramSource:
    return FlowTelegramSource(SourceBinding(source_id="ds-tg", config=config), hub=hub)


def _update(text: str, *, sender: str = ME, message_id: int = 7, reply_to: int = 0) -> dict:
    message = {
        "message_id": message_id,
        "from": {"id": int(sender), "is_bot": False, "first_name": "Dana"},
        "chat": {"id": int(sender), "type": "private"},
        "date": 1700000000,
        "text": text,
    }
    if reply_to:
        message["reply_to_message"] = {"message_id": reply_to}
    return {"message": message}


async def test_connect_claims_telegram_and_shows_the_t_me_link():
    hub = _Hub()
    answer = await _source(hub)._connect(check=False, values={})
    assert answer.ok and answer.value.shown.link == f"{T_ME}?code=AB2CD3"
    assert hub.channels == ["telegram"]


async def test_the_gate_keeps_the_telegram_account():
    hub = _Hub()
    await hub.connect("telegram", {})
    source = _source(hub, claim_id="C1")
    assert "send the message from your Telegram account" in (await source._connected(check=False, values={})).detail
    hub.connected("C1", ME)
    done = await source._connected(check=False, values={})
    assert done.ok and done.value.config == {"sender": ME} and done.value.allowed_senders == [ME]


async def test_an_update_becomes_an_item_keyed_as_the_hub_keys_it():
    async with _source(_Hub(), sender=ME) as source:
        (asked,) = [e.item for e in source.events_from_webhook(_update("hi"))]
        (quoting,) = [e.item for e in source.events_from_webhook(_update("and", message_id=8, reply_to=7))]
        other = source.events_from_webhook(_update("x", sender="5550002"))
    assert asked.origin.key == f"{ME}:7" and asked.data.sender.name == "Dana" and asked.data.conversation.key == ME
    assert quoting.data.in_reply_to.key == f"{ME}:7"
    assert other == [], "only this source's own account"


async def test_a_reply_names_the_message_as_the_hub_named_it():
    hub = _Hub()
    async with _source(hub, claim_id="C1", sender=ME) as source:
        asked = source.message_origin(f"{ME}:7", ME)
        sent = await source.reply(asked, MessageData(text="Sure."))
    assert hub.replies == [("C1", "Sure.", f"{ME}:7")] and sent.data.in_reply_to == asked


def test_an_agent_answers_whatever_the_claim_delivers_on_any_machine():
    """The hub's claim admits only the proven sender, so the channel is open inbound: a copy of it on the agent's cloud
    box (which never sees the desktop's allowlist) answers too."""
    from flow_sdk.builtin.agent_serve import admits
    from flow_sdk.builtin.data_source import SourceStatus
    from types import SimpleNamespace

    box_copy = SimpleNamespace(provider="flow_telegram", status=SourceStatus.ACTIVE.value, allowed_senders=[])
    assert FlowTelegramSource.open_inbound and admits(box_copy, ME)
