"""The ``flow_whatsapp`` data source: one person's WhatsApp conversation on Flowpad's number, through the hub's chain.

Offline by construction: the source is handed a fake hub. What is pinned:

* Connect makes a claim on the hub's ``@whatsapp`` root, targeted at THIS channel on THIS instance, and shows the
  code and the link that sends it — and says the hub's own words when it cannot;
* the gate (``connected``) passes ONLY once the hub validated the code, and says why not until then;
* what the hub hands this channel becomes its items — its own phone only;
* a reply goes back through the claim, naming the message it answers; nothing else is reachable.
"""
from __future__ import annotations

import base64
import time

import pytest

from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import NotFound, Unsupported
from flow_sdk.sources.files import local_file
from flow_sdk.sources.setup_steps import SourceUpdateSpec
from flow_sdk.sources.testing.flow_hub import FakeFlowHub
from flow_sdk.sources.values.items import MessageData

module = asset_module("flow_whatsapp")
FlowWhatsAppSource = module.FlowWhatsAppSource

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PHONE = "972500000001"
WA_ME = "https://wa.me/15550100"


def _Hub(**kw) -> FakeFlowHub:
    """The hub's chain as WhatsApp on Flowpad's number sees it: the wa.me link that pre-fills the code."""
    return FakeFlowHub(deep_link=WA_ME, **kw)


def _source(hub, **config) -> FlowWhatsAppSource:
    return FlowWhatsAppSource(SourceBinding(source_id="ds-1", config=config), hub=hub)


def _meta(message: dict) -> dict:
    """One message in Meta's own envelope, as the hub's ``@whatsapp`` webhook hands it to this channel."""
    value = {"metadata": {"phone_number_id": "PNID"}, "contacts": [{"wa_id": PHONE, "profile": {"name": "Dana"}}], "messages": [message]}
    return {"object": "whatsapp_business_account", "entry": [{"changes": [{"value": value}]}]}


async def test_connect_claims_the_channel_and_shows_the_code_and_the_link_that_sends_it():
    hub = _Hub()
    source = _source(hub)

    assert not (await source._connect(check=True, values={})).ok, "no code yet"
    answer = await source._connect(check=False, values={})

    update = answer.value
    assert answer.ok and isinstance(update, SourceUpdateSpec) and update.config == {"claim_id": "C1"}
    shown = update.shown
    assert shown.code == "AB2CD3" and shown.link == f"{WA_ME}?code=AB2CD3" and shown.qr.startswith("data:image/svg+xml;base64,")
    assert hub.channels == ["whatsapp"], "the claim is on the whatsapp root only"
    svg = base64.b64decode(shown.qr.split(",", 1)[1]).decode()
    assert 'xmlns="http://www.w3.org/2000/svg"' in svg, "an <img> renders an SVG only with its namespace"
    assert '<path fill="#fff"' in svg, "a white background: black squares vanish on a dark dialog, and cameras read dark-on-light"

    # Read back later (a resumed wizard), the claim carries the same deep link.
    again = await _source(hub, claim_id="C1")._connect(check=True, values={})
    assert again.ok and not again.ran and again.value.shown.link == shown.link


async def test_connect_says_the_hubs_own_words_when_it_cannot():
    answer = await _source(_Hub(refuse="the hub has no 'whatsapp' account"))._connect(check=False, values={})
    assert not answer.ok and "no 'whatsapp' account" in answer.detail


async def test_the_gate_passes_only_once_the_hub_validated_the_phone():
    hub = _Hub()
    await hub.connect("whatsapp", {})
    source = _source(hub, claim_id="C1")

    assert "Connect WhatsApp first" in (await _source(hub)._connected(check=False, values={})).detail
    pending = await source._connected(check=False, values={})
    assert not pending.ok and "send the message from your phone" in pending.detail

    hub.claims["C1"]["code_expires_at"] = time.time() - 1
    assert "expired" in (await source._connected(check=False, values={})).detail

    hub.connected("C1", PHONE)
    done = await source._connected(check=False, values={})
    assert done.ok and done.value.config == {"wa_id": PHONE} and done.value.allowed_senders == [PHONE]
    assert (await _source(hub, claim_id="C1", wa_id=PHONE)._connected(check=True, values={})).ok


async def test_connect_targets_this_instance_and_this_channel(monkeypatch):
    from flow_sdk.instance_settings import runtime

    monkeypatch.setattr(runtime, "instance_uid", lambda: "11111111-2222-4333-8444-555555555555")
    hub = _Hub()
    await _source(hub)._connect(check=False, values={})
    assert hub.targets == [{"instance_id": "11111111-2222-4333-8444-555555555555", "data_source_id": "ds-1"}]


async def test_what_the_hub_hands_this_channel_becomes_its_items():
    async with _source(_Hub(), wa_id=PHONE) as source:
        asked = source.events_from_webhook(
            _meta({"from": PHONE, "id": "wamid.IN1", "timestamp": "100", "type": "text", "text": {"body": "hi"}})
        )
    (inbound,) = [e.item for e in asked]
    assert inbound.data.text == "hi" and inbound.data.sender.name == "Dana" and inbound.origin.key == "wamid.IN1"
    assert inbound.data.conversation.key == PHONE


async def test_a_source_takes_its_own_phone_only_and_nothing_it_cannot_render():
    """Two sources of one person (one abandoned before its phone connected) put each message in the stream inbox twice."""
    async with _source(_Hub(), wa_id=PHONE) as source:
        other = source.events_from_webhook(
            _meta({"from": "972500000099", "id": "w.B", "timestamp": "1", "type": "text", "text": {"body": "x"}})
        )
        image = source.events_from_webhook(_meta({"from": PHONE, "id": "w.C", "timestamp": "1", "type": "image", "image": {"id": "m"}}))
        junk = source.events_from_webhook({"entry": "nope"})
    assert other == [] and image == [] and junk == []


async def test_a_reply_goes_back_through_the_claim_naming_what_it_answers(tmp_path):
    hub = _Hub()
    async with _source(hub, claim_id="C1", wa_id=PHONE) as source:
        asked = source.message_origin("wamid.IN1", PHONE)
        sent = await source.reply(asked, MessageData(text="Three things today."))
        assert hub.replies == [("C1", "Three things today.", "wamid.IN1")]
        assert sent.origin.key == "OUT1" and sent.data.in_reply_to == asked

        await source.send(MessageData(text="And one more.", conversation=source.conversation_origin(PHONE)))
        assert hub.replies[-1] == ("C1", "And one more.", "")

        with pytest.raises(NotFound):
            await source.send(MessageData(text="x", conversation=source.conversation_origin("972500000099")))
        path = tmp_path / "a.png"
        path.write_bytes(b"x")
        with pytest.raises(Unsupported):
            await source.send(MessageData(text="x", conversation=source.conversation_origin(PHONE), attachments=(local_file(path),)))


def test_the_connect_wizard_ends_at_connected_and_ships_no_local_agent():
    """The setup is Connect and the validated phone; who answers here is the instance's own choice."""
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "agentic-assets"
    wizard = json.loads((root / "wizard" / "flow-whatsapp-connect" / "wizard.json").read_text())
    assert [s["id"] for s in wizard["steps"]] == ["connect", "ask-connected"]
    assert not (root / "agent").exists()
    assert sorted(p.name for p in (root / "compute_op").iterdir()) == ["flow-whatsapp-ask-connected", "flow-whatsapp-connect"]
