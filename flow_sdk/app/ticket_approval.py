"""A help-desk ticket is answered only after a person on the team approved the answer.

The support agent opens a private ``[ticket <ticket id>] …`` conversation with its team and replies to the
ticket with ``flow conversation reply``. That reply is refused here unless that private conversation holds
an ``approve`` written by a person other than the account this Flowpad runs as -- the agent runs as that
account, so nothing it writes can approve itself.
"""

from __future__ import annotations

import re

from flow_sdk.builtin.conversation import Conversation, ConversationKind
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.user import User
from flow_sdk.schema.data_spec.message_sender_spec import SenderKind

_APPROVE = re.compile(r"\bapprove[ds]?\b", re.IGNORECASE)


async def unapproved_reason(conversation_id: str) -> str:
    """Why a reply into *conversation_id* must not go yet; ``""`` when it may (not a ticket, or approved)."""
    ticket = await Conversation.get_by_id(conversation_id)
    if ticket is None or ticket.kind != ConversationKind.HELPDESK:
        return ""
    prefix = f"[ticket {conversation_id}]"
    private = [c for c in await Conversation.get_all({}) if str(c.title or "").startswith(prefix)]
    if not private:
        return f"no private conversation titled {prefix} exists: the team has not been asked"
    own = await User.self_ids()
    for conversation in private:
        for message in await FlowMessage.get_all({"conversation_id": str(conversation.id)}):
            sender = message.sender
            if (
                sender is not None
                and sender.kind is SenderKind.USER
                and str(sender.id or "") not in own
                and _APPROVE.search(message.text or "")
            ):
                return ""
    return f"the team has not approved: {prefix} holds no `approve` from a team member"
