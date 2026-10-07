"""``FlowTelegramSource`` — Flow on Telegram: Flowpad's own bot, your Telegram account linked to it.

A ``FlowChannel`` (``flow_sdk/sources/flow_channel.py``): Connect, the gate, the stream inbox mirror and answering are the
same on every Flow channel. What is Telegram's is here: the envelope is a Bot API ``Update`` (``{"message": …}``,
Flow's own answer in the same shape), a person is their numeric user id (their private chat with the bot has the
same id), and a message id is only unique inside its chat — so a message is ``<chat id>:<message id>``, exactly as
the hub names it. The deep link is ``t.me/<bot>?start=<code>``: Telegram sends ``/start <code>`` when you press Start.
"""

from __future__ import annotations

from typing import Any

from flow_sdk.sources.flow_channel import FlowChannel, unix_time

#: The medium (the stream inbox shows it as Telegram), not the transport.
CHANNEL = "telegram"


class FlowTelegramSource(FlowChannel):
    provider = "flow_telegram"
    origin_kind = CHANNEL
    channel = CHANNEL
    title = "Telegram"
    #: As on Telegram itself: a reply quotes the message it answers in the chat.
    quotes = True
    noun = "Telegram account"

    def sender_of(self, value: Any) -> str:
        text = str(value or "").strip()
        return text if text.lstrip("-").isdigit() else ""

    def display_sender(self, sender: str) -> str:
        return f"Telegram {sender}"

    def items_of(self, payload: dict, *, outbound: bool) -> list[dict]:
        message = payload.get("message")
        if not isinstance(message, dict):
            return []
        chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
        author = message.get("from") if isinstance(message.get("from"), dict) else {}
        chat_id = str(chat.get("id") or "")
        replied = (message.get("reply_to_message") or {}).get("message_id")
        name = " ".join(str(x) for x in (author.get("first_name"), author.get("last_name")) if x)
        return [
            {
                "id": f"{chat_id}:{message.get('message_id')}" if chat_id and message.get("message_id") else "",
                "sender": chat_id,
                "name": None if outbound else name or None,
                "text": str(message.get("text") or ""),
                "reply_to": f"{chat_id}:{replied}" if replied else "",
                "at": unix_time(message.get("date")),
            }
        ]
