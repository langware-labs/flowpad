"""``FlowWhatsAppSource`` — WhatsApp on Flowpad's own number, your phone linked to it.

A ``FlowChannel`` (``flow_sdk/sources/flow_channel.py``): Connect, the gate, inbound and the reply back through the
hub are the same on every such channel. What is WhatsApp's is here: Meta's envelope
(``entry[].changes[].value.messages[]``), a person is their phone number (digits), and the setup shows it as
``+<digits>``. The deep link is ``wa.me`` pre-filling ``link <code>``.
"""

from __future__ import annotations

from typing import Any

from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.flow_channel import FlowChannel, unix_time

#: The medium (the stream inbox shows it as WhatsApp), not the transport.
CHANNEL = "whatsapp"
class FlowWhatsAppConfig(SourceConfig):
    """One person's link. Written by the setup steps, never typed."""

    #: The hub claim this source receives through (pending until the phone sends its code).
    claim_id: str = ""
    #: The person's phone, once the hub validated it.
    wa_id: str = ""


class FlowWhatsAppSource(FlowChannel):
    Config = FlowWhatsAppConfig
    provider = "flow_whatsapp"
    origin_kind = CHANNEL
    identity_config_key = "wa_id"
    channel = CHANNEL
    title = "WhatsApp"
    #: As on WhatsApp itself: a reply quotes the message it answers on the phone.
    quotes = True
    noun = "phone"


    def sender_of(self, value: Any) -> str:
        return _digits(value)

    def display_sender(self, sender: str) -> str:
        return f"+{sender}"

    def items_of(self, payload: dict) -> list[dict]:
        items: list[dict] = []
        for entry in _list(payload.get("entry")):
            for change in _list(entry.get("changes") if isinstance(entry, dict) else None):
                value = change.get("value") if isinstance(change, dict) and isinstance(change.get("value"), dict) else {}
                names = {
                    _digits(c.get("wa_id")): str((c.get("profile") or {}).get("name") or "")
                    for c in _list(value.get("contacts"))
                    if isinstance(c, dict)
                }
                for message in _list(value.get("messages")):
                    if not isinstance(message, dict):
                        continue
                    sender = _digits(message.get("from"))
                    items.append(
                        {
                            "id": str(message.get("id") or ""),
                            "sender": sender,
                            "name": names.get(sender) or None,
                            "text": _text_of(message),
                            "reply_to": str((message.get("context") or {}).get("id") or ""),
                            "at": unix_time(message.get("timestamp")),
                        }
                    )
        return items


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _text_of(message: dict) -> str:
    kind = message.get("type")
    if kind == "text":
        return str((message.get("text") or {}).get("body") or "")
    if kind == "button":
        return str((message.get("button") or {}).get("text") or "")
    if kind == "interactive":
        reply = message.get("interactive") or {}
        return str((reply.get("button_reply") or reply.get("list_reply") or {}).get("title") or "")
    return ""


def _digits(value: Any) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())
