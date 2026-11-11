"""A help-desk ticket is answered only after a person on the team approved the answer.

The support agent opens a private ``[ticket <ticket id>] …`` conversation with its team and replies to the
ticket with ``flow conversation reply``. That reply is refused here unless that private conversation ends
with an ``approve`` written by a person other than the account this Flowpad runs as -- the agent runs as that
account, so nothing it writes can approve itself. The approval counts for the answer proposed before it: any
later message from the agent's account (a changed proposal) needs a fresh one.
"""

from __future__ import annotations

import re

from flow_sdk.builtin.conversation import Conversation, ConversationKind
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.user import User
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.schema.data_spec.message_sender_spec import SenderKind

#: The whole message: `approve`, nothing around it ("not approved", "should I approve?" do not count).
_APPROVE = re.compile(r"\s*approved?[\s.!]*", re.IGNORECASE)


async def unapproved_reason(conversation_id: str) -> str:
    """Why a reply into *conversation_id* must not go yet; ``""`` when it may (not a ticket, or approved)."""
    ticket = await Conversation.get_by_id(conversation_id)
    if ticket is None or ticket.kind != ConversationKind.HELPDESK:
        return ""
    prefix = f"[ticket {conversation_id}]"
    like = QueryFilter(match=ExpressionNode(op=QueryOp.LIKE, operands=["title", f"{prefix}%"]))
    private = [c for c in await Conversation.get_all(like) if str(c.title or "").startswith(prefix)]
    if not private:
        return f"no private conversation titled {prefix} exists: the team has not been asked"
    own = await User.self_ids()
    for conversation in private:
        messages = sorted(
            await FlowMessage.get_all({"conversation_id": str(conversation.id)}),
            key=lambda m: m.occurred_at.timestamp() if m.occurred_at else 0.0,
        )
        for message in reversed(messages):
            sender = message.sender
            if sender is None or sender.kind is not SenderKind.USER:
                continue
            if str(sender.id or "") in own:
                break  # the agent's own latest word: nothing after it approved it
            if _APPROVE.fullmatch(message.text or ""):
                return ""
    return f"the team has not approved: {prefix} holds no `approve` from a team member after the latest proposal"
