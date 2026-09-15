"""``EmailAddressing`` — how a mail source reads the application's send arguments.

Shared by every source whose channel is email, because the rule is email's, not a provider's: a
reply to a known message keeps the exchange one thread on the recipient's side; a bare send to
``to`` starts a new one, and only then does ``subject`` mean anything.
"""
from __future__ import annotations

from typing import Optional

from flow_sdk.sources.values.items import EmailMessageData, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin


class EmailAddressing:
    """Mixed into a mail ``Source``; ``origin`` and ``provider`` are the source's own."""

    def message_for(
        self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""
    ) -> tuple[EmailMessageData, Optional[CloudOrigin]]:
        answered = str(in_reply_to or "").strip()
        if answered:
            return EmailMessageData(text=text), self.origin(answered)  # type: ignore[attr-defined]
        address = str(to or "").strip()
        if not address:
            raise ValueError(f"a {self.provider} send needs a recipient address in `to`")  # type: ignore[attr-defined]
        recipient = UserProfile(origin=self.origin(address), address=address)  # type: ignore[attr-defined]
        return EmailMessageData(text=text, subject=subject or None, recipients=(recipient,)), None


__all__ = ["EmailAddressing"]
