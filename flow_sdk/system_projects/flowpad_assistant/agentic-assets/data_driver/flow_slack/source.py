"""``FlowSlackSource`` — Flow in Slack: Flowpad's own Slack app, your Slack account linked to it.

A ``FlowChannel`` (``flow_sdk/sources/flow_channel.py``): Connect, the gate, the inbox mirror and answering are the
same on every Flow channel. What is Slack's is here: the envelope is an Events API ``event_callback`` (a DM to the
app; Flow's own answer in the same shape, naming the person as ``user``), a person is their Slack user id, and a
message is ``<channel>:<ts>``, exactly as the hub names it. Connect's link adds the Flow app to the person's
workspace and opens its DM, where they send ``link <code>``.
"""

from __future__ import annotations

from typing import Any

from flow_sdk.sources.flow_channel import FlowChannel, unix_time

#: The medium (the stream inbox shows it as Slack), not the transport.
CHANNEL = "slack"


class FlowSlackSource(FlowChannel):
    provider = "flow_slack"
    origin_kind = CHANNEL
    channel = CHANNEL
    title = "Slack"
    noun = "Slack account"

    def sender_of(self, value: Any) -> str:
        text = str(value or "").strip()
        return text if text.isalnum() else ""

    def display_sender(self, sender: str) -> str:
        return f"Slack {sender}"

    def items_of(self, payload: dict, *, outbound: bool) -> list[dict]:
        event = payload.get("event")
        if not isinstance(event, dict) or event.get("type") != "message":
            return []
        channel, ts = str(event.get("channel") or ""), str(event.get("ts") or "")
        replied = str(event.get("flowpad_reply_to") or event.get("thread_ts") or "")
        return [
            {
                "id": f"{channel}:{ts}" if channel and ts else "",
                "sender": str(event.get("user") or ""),
                "name": None,
                "text": str(event.get("text") or ""),
                "reply_to": f"{channel}:{replied}" if replied and replied != ts else "",
                "at": unix_time(ts),
            }
        ]
