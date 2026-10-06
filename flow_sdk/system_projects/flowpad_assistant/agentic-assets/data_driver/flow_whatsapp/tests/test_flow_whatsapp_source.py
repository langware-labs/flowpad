"""The ``flow_whatsapp`` data source: one person's WhatsApp conversation with Flow, entirely through the hub.

Offline by construction: the source is handed a fake hub. What is pinned:

* Connect shows Flow's card, the code and the link that sends it — and refuses when the hub has no Flow;
* the gate (``connected``) passes ONLY once the hub validated the code, and says why not until then;
* what the hub hands this channel (the phone's message, Flow's answer) becomes its items — its own phone only —
  and an answer goes to the person's own phone, quoting what it answers.
"""
from __future__ import annotations

import base64
import time

import pytest

from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import Unsupported
from flow_sdk.sources.setup_steps import SourceUpdateSpec
from flow_sdk.sources.files import local_file
from flow_sdk.sources.values.items import MessageData

module = asset_module("flow_whatsapp")
FlowWhatsAppSource = module.FlowWhatsAppSource

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PHONE = "972500000001"
PROFILE = {"available": True, "name": "Flow", "number": "+1 555 0100", "wa_me": "https://wa.me/15550100", "avatar": ""}


class _Hub:
    def __init__(self, *, available=True):
        self.profile_ = {**PROFILE, "available": available}
        self.links: dict = {}
        self.stored: list = []
        self.sent: list = []

    async def profile(self):
        return dict(self.profile_)

    async def connect(self, channel):
        self.channel = channel
        link = {"id": f"L{len(self.links) + 1}", "status": "pending", "code": "AB2CD3", "code_expires_at": time.time() + 900}
        self.links[link["id"]] = link
        return {**link, "link": "https://wa.me/15550100?text=link%20AB2CD3"}

    async def link(self, link_id):
        return dict(self.links[link_id]) if link_id in self.links else None

    async def send(self, wa_id, text, reply_to):
        self.sent.append((wa_id, text, reply_to))
        return {"wamid": f"wamid.OUT{len(self.sent)}", "direction": "out"}


def _source(hub, **config) -> FlowWhatsAppSource:
    return FlowWhatsAppSource(SourceBinding(source_id="ds-1", config=config), hub=hub)


def _meta(message: dict, *, out: bool = False) -> dict:
    """One message in Meta's own envelope, as the hub's ``@whatsapp`` webhook hands it to this channel."""
    value = {"metadata": {"phone_number_id": "PNID"}, "contacts": [{"wa_id": PHONE, "profile": {"name": "Dana"}}], "messages": [message]}
    envelope = {"object": "whatsapp_business_account", "entry": [{"changes": [{"value": value}]}]}
    return {**envelope, "flowpad_direction": "out"} if out else envelope


async def test_connect_shows_flow_the_code_and_the_link_that_sends_it():
    hub = _Hub()
    source = _source(hub)

    assert not (await source._connect(check=True, values={})).ok, "no code yet"
    answer = await source._connect(check=False, values={})

    update = answer.value
    assert answer.ok and isinstance(update, SourceUpdateSpec) and update.config == {"link_id": "L1"}
    shown = update.shown
    assert (shown.name, shown.number, shown.code) == ("Flow", "+1 555 0100", "AB2CD3")
    assert shown.link == "https://wa.me/15550100?text=link%20AB2CD3" and shown.qr.startswith("data:image/svg+xml;base64,")
    svg = base64.b64decode(shown.qr.split(",", 1)[1]).decode()
    assert 'xmlns="http://www.w3.org/2000/svg"' in svg, "an <img> renders an SVG only with its namespace"
    assert '<path fill="#fff"' in svg, "a white background: black squares vanish on a dark dialog, and cameras read dark-on-light"

    # Read back later (a resumed wizard), the link carries only its code — the link is rebuilt from Flow's number.
    again = await _source(hub, link_id="L1")._connect(check=True, values={})
    assert again.ok and not again.ran and again.value.shown.link == shown.link


async def test_connect_refuses_when_the_hub_has_no_flow():
    answer = await _source(_Hub(available=False))._connect(check=False, values={})
    assert not answer.ok and "not available" in answer.detail


async def test_the_gate_passes_only_once_the_hub_validated_the_phone():
    hub = _Hub()
    await hub.connect({})
    source = _source(hub, link_id="L1")

    assert "Connect WhatsApp first" in (await _source(hub)._connected(check=False, values={})).detail
    pending = await source._connected(check=False, values={})
    assert not pending.ok and "send the message from your phone" in pending.detail

    hub.links["L1"]["code_expires_at"] = time.time() - 1
    assert "expired" in (await source._connected(check=False, values={})).detail

    hub.links["L1"].update(status="connected", wa_id=PHONE, code="")
    done = await source._connected(check=False, values={})
    assert done.ok and done.value.config == {"wa_id": PHONE} and done.value.allowed_senders == [PHONE]
    assert (await _source(hub, link_id="L1", wa_id=PHONE)._connected(check=True, values={})).ok


async def test_connect_tells_the_hub_which_instance_and_channel_take_the_conversation(monkeypatch):
    from flow_sdk.instance_settings import runtime

    monkeypatch.setattr(runtime, "instance_uid", lambda: "11111111-2222-4333-8444-555555555555")
    hub = _Hub()
    await _source(hub)._connect(check=False, values={})
    assert hub.channel == {"instance_id": "11111111-2222-4333-8444-555555555555", "data_source_id": "ds-1"}


async def test_what_the_hub_hands_this_channel_becomes_its_items_both_directions():
    async with _source(_Hub(), wa_id=PHONE) as source:
        asked = source.events_from_webhook(
            _meta({"from": PHONE, "id": "wamid.IN1", "timestamp": "100", "type": "text", "text": {"body": "hi"}})
        )
        answered = source.events_from_webhook(
            _meta(
                {"to": PHONE, "id": "wamid.OUT1", "timestamp": "101", "type": "text", "text": {"body": "hello"}, "context": {"id": "wamid.IN1"}},
                out=True,
            )
        )
    (inbound,) = [e.item for e in asked]
    (outbound,) = [e.item for e in answered]
    assert inbound.data.text == "hi" and inbound.data.sender.name == "Dana" and inbound.origin.key == "wamid.IN1"
    assert outbound.data.text == "hello" and outbound.data.sender.name == "Flow"
    assert outbound.data.in_reply_to.key == "wamid.IN1" and outbound.data.conversation.key == PHONE


async def test_a_source_takes_its_own_phone_only_and_nothing_it_cannot_render():
    """Two sources of one person (one abandoned before its phone connected) put each message in the stream inbox twice."""
    async with _source(_Hub(), wa_id=PHONE) as source:
        other = source.events_from_webhook(
            _meta({"from": "972500000099", "id": "w.B", "timestamp": "1", "type": "text", "text": {"body": "x"}})
        )
        image = source.events_from_webhook(_meta({"from": PHONE, "id": "w.C", "timestamp": "1", "type": "image", "image": {"id": "m"}}))
        junk = source.events_from_webhook({"entry": "nope"})
    assert other == [] and image == [] and junk == []


async def test_an_answer_goes_to_the_persons_phone_quoting_what_it_answers(tmp_path):
    hub = _Hub()
    async with _source(hub, wa_id=PHONE) as source:
        asked = source.message_origin("wamid.IN1", PHONE)
        sent = await source.reply(asked, MessageData(text="Three things today."))
        assert hub.sent == [(PHONE, "Three things today.", "wamid.IN1")]
        assert sent.origin.key == "wamid.OUT1" and sent.data.in_reply_to == asked

        path = tmp_path / "a.png"
        path.write_bytes(b"x")
        with pytest.raises(Unsupported):
            await source.send(MessageData(text="x", conversation=source.conversation_origin(PHONE), attachments=(local_file(path),)))


def test_the_connect_wizard_ends_at_connected_and_ships_no_local_agent():
    """Flow answers from the hub, on a machine of the person's own: the desktop's setup is Connect and the
    validated phone, nothing that makes this desktop answer (two answerers would answer twice)."""
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "agentic-assets"
    wizard = json.loads((root / "wizard" / "flow-whatsapp-connect" / "wizard.json").read_text())
    assert [s["id"] for s in wizard["steps"]] == ["connect", "ask-connected"]
    assert not (root / "agent").exists()
    assert sorted(p.name for p in (root / "compute_op").iterdir()) == ["flow-whatsapp-ask-connected", "flow-whatsapp-connect"]
