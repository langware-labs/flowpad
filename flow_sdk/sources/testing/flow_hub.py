"""``FakeFlowHub`` — the hub a ``FlowChannel`` talks to, as a test double every Flow channel driver shares.

It keeps links in memory the way ``channel_link`` does: Connect mints a pending link with a code and its deep link,
the test flips it to connected (as the hub does once the code came back from the person's account), and sends
are recorded with the id the hub would answer.
"""

from __future__ import annotations

import time
from typing import Optional


class FakeFlowHub:
    def __init__(self, *, available: bool = True, display: str = "", deep_link: str = "https://example.test/flow"):
        self.profile_ = {"available": available, "name": "Flow", "display": display, "avatar": "", "deep_link": deep_link}
        self.deep_link_base = deep_link
        self.links: dict[str, dict] = {}
        self.sent: list[tuple[str, str, str]] = []
        self.where: dict = {}
        self.channels: list[str] = []

    async def profile(self, channel: str) -> dict:
        self.channels.append(channel)
        return dict(self.profile_)

    async def connect(self, channel: str, where: dict) -> dict:
        self.channels.append(channel)
        self.where = where
        code = "AB2CD3"
        link = {
            "id": f"L{len(self.links) + 1}",
            "provider": channel,
            "status": "pending",
            "code": code,
            "code_expires_at": time.time() + 900,
            "deep_link": f"{self.deep_link_base}?code={code}",
        }
        self.links[link["id"]] = link
        return dict(link)

    async def link(self, link_id: str) -> Optional[dict]:
        return dict(self.links[link_id]) if link_id in self.links else None

    async def send(self, channel: str, sender: str, text: str, reply_to: str) -> dict:
        self.channels.append(channel)
        self.sent.append((sender, text, reply_to))
        return {"message_id": f"OUT{len(self.sent)}", "direction": "out", "sender": sender}

    def connected(self, link_id: str, sender: str) -> dict:
        """The hub validated the code from ``sender``'s account."""
        self.links[link_id].update(status="connected", sender=sender, sender_key=sender, code="")
        return self.links[link_id]


__all__ = ["FakeFlowHub"]
