"""The ``flow_whatsapp`` data source: one person's WhatsApp conversation with Flow, entirely through the hub.

Offline by construction: the source is handed a fake hub. What is pinned:

* Connect shows Flow's card, the code and the link that sends it — and refuses when the hub has no Flow;
* the gate (``connected``) passes ONLY once the hub validated the code, and says why not until then;
* what the phone sent is read after the cursor, and an answer goes to the person's own phone, quoting what it answers.
"""
from __future__ import annotations

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

    async def connect(self):
        link = {"id": f"L{len(self.links) + 1}", "status": "pending", "code": "AB2CD3", "code_expires_at": time.time() + 900}
        self.links[link["id"]] = link
        return {**link, "link": "https://wa.me/15550100?text=link%20AB2CD3"}

    async def link(self, link_id):
        return dict(self.links[link_id]) if link_id in self.links else None

    async def messages(self, since):
        return [m for m in self.stored if m["at"] > since]

    async def send(self, wa_id, text, reply_to):
        self.sent.append((wa_id, text, reply_to))
        return {"wamid": f"wamid.OUT{len(self.sent)}", "direction": "out"}


def _source(hub, **config) -> FlowWhatsAppSource:
    return FlowWhatsAppSource(SourceBinding(config=config), hub=hub)


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

    # Read back later (a resumed wizard), the link carries only its code — the link is rebuilt from Flow's number.
    again = await _source(hub, link_id="L1")._connect(check=True, values={})
    assert again.ok and not again.ran and again.value.shown.link == shown.link


async def test_connect_refuses_when_the_hub_has_no_flow():
    answer = await _source(_Hub(available=False))._connect(check=False, values={})
    assert not answer.ok and "not available" in answer.detail


async def test_the_gate_passes_only_once_the_hub_validated_the_phone():
    hub = _Hub()
    await hub.connect()
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


async def test_what_the_phone_sent_is_read_after_the_cursor():
    hub = _Hub()
    hub.stored = [
        {"wamid": "wamid.IN1", "wa_id": PHONE, "direction": "in", "text": "hi", "profile_name": "Dana", "at": 100.0},
        {"wamid": "wamid.OUT1", "wa_id": PHONE, "direction": "out", "text": "hello", "reply_to": "wamid.IN1", "at": 101.0},
    ]
    async with _source(hub, wa_id=PHONE) as source:
        first = await source.fetch()
        assert [i.data.text for i in first.items] == ["hi", "hello"]
        assert first.items[0].data.sender.name == "Dana" and first.items[1].data.in_reply_to.key == "wamid.IN1"

        hub.stored.append({"wamid": "wamid.IN2", "wa_id": PHONE, "direction": "in", "text": "more", "at": 102.0})
        later = await source.fetch(first.resume_cursor)
        assert [i.data.text for i in later.items] == ["more"]


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
