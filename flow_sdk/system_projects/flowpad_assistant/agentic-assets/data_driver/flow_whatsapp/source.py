"""``FlowWhatsAppSource`` — Flow on WhatsApp: Flowpad's own number, your phone linked to it.

A ``FlowChannel`` (``flow_sdk/sources/flow_channel.py``): Connect, the gate, the stream inbox mirror and answering are the
same on every Flow channel. What is WhatsApp's is here: Meta's envelope (``entry[].changes[].value.messages[]``,
``to`` instead of ``from`` on Flow's own answer), a person is their phone number (digits), and the setup shows it
as ``+<digits>``. The deep link is ``wa.me`` pre-filling ``link <code>``.

Sources connected before channels were generic keep their ``wa_id`` config and a ``whatsapp_link`` row on the
hub; both are still read.
"""

from __future__ import annotations

from typing import Any, Optional

from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.flow_channel import AppHub, FlowChannel, unix_time

#: The medium (the stream inbox shows it as WhatsApp), not the transport.
CHANNEL = "whatsapp"
#: Where a desktop released before channels were generic made its link.
LEGACY_LINK_ENTITY = "whatsapp_link"


class FlowWhatsAppHub(AppHub):
    """``channel_link``, and the ``whatsapp_link`` row an older version of this source connected through."""

    async def link(self, link_id: str) -> Optional[dict]:
        found = await super().link(link_id)
        if found is not None:
            return found
        from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

        legacy = await hub_get(LEGACY_LINK_ENTITY, link_id)
        return dict(legacy) if isinstance(legacy, dict) else None


class FlowWhatsAppConfig(SourceConfig):
    """One person's link to Flow. Written by the setup steps, never typed."""

    #: The hub link this source reads through (pending until the phone sends its code).
    link_id: str = ""
    #: The person's phone, once the hub validated it (``sender``, under the name sources connected before
    #: channels were generic already carry).
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

    @classmethod
    def build(cls, binding) -> "FlowWhatsAppSource":
        return cls(binding, hub=FlowWhatsAppHub())

    def sender_of(self, value: Any) -> str:
        return _digits(value)

    def display_sender(self, sender: str) -> str:
        return f"+{sender}"

    def items_of(self, payload: dict, *, outbound: bool) -> list[dict]:
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
                    sender = _digits(message.get("to") if outbound else message.get("from"))
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
