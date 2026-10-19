"""``FakeFlowHub`` — the hub a ``FlowChannel`` talks to, as a test double every such channel driver shares.

It keeps claims in memory the way the hub's webhook chain does: Connect makes a pending user claim with a code and
its deep link, the test flips it to active (as the hub does once the code came back from the person's account), and
replies are recorded with the id the hub would answer.
"""

from __future__ import annotations

import time
from typing import Optional


class FakeFlowHub:
    def __init__(self, *, deep_link: str = "https://example.test/flow", refuse: str = ""):
        self.deep_link_base = deep_link
        #: When set, Connect fails with these words (the hub has no such channel).
        self.refuse = refuse
        self.claims: dict[str, dict] = {}
        self.replies: list[tuple[str, str, str]] = []
        self.targets: list[dict] = []
        self.channels: list[str] = []

    async def connect(self, channel: str, target: dict) -> dict:
        if self.refuse:
            raise RuntimeError(self.refuse)
        self.channels.append(channel)
        self.targets.append(target)
        code = "AB2CD3"
        claim = {
            "id": f"C{len(self.claims) + 1}",
            "provider": channel,
            "status": "pending",
            "claim": {"kind": "user", "key": ""},
            "code": code,
            "code_expires_at": time.time() + 900,
            "deep_link": f"{self.deep_link_base}?code={code}",
        }
        self.claims[claim["id"]] = claim
        return dict(claim)

    async def claim(self, claim_id: str) -> Optional[dict]:
        return dict(self.claims[claim_id]) if claim_id in self.claims else None

    async def reply(self, claim_id: str, text: str, event_id: str) -> dict:
        self.replies.append((claim_id, text, event_id))
        return {"message_id": f"OUT{len(self.replies)}", "reply_to": event_id}

    def connected(self, claim_id: str, key: str) -> dict:
        """The hub validated the code from the account ``key`` (the claim's key, as the hub proves it)."""
        sender = key.rsplit(":", 1)[-1]  # as the hub reads a workspace-scoped key back (``account_and_sender``)
        self.claims[claim_id].update(
            status="active", claim={"kind": "user", "key": key}, sender=sender, code="", deep_link=""
        )
        return self.claims[claim_id]


__all__ = ["FakeFlowHub"]
