"""A reply into a help-desk ticket waits for a team member's `approve` in the ticket's private conversation."""

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

import flow_sdk.app.ticket_approval as approval
from flow_sdk.builtin.conversation import ConversationKind
from flow_sdk.schema.data_spec.message_sender_spec import MessageSender

pytestmark = pytest.mark.asyncio

TICKET = "t1"


def _world(monkeypatch, messages, *, kind=ConversationKind.HELPDESK, private=True):
    conversations = {TICKET: SimpleNamespace(id=TICKET, kind=kind, title="ticket")}
    everyone = list(conversations.values())
    if private:
        everyone.append(SimpleNamespace(id="p1", kind=ConversationKind.DIRECT, title=f"[ticket {TICKET}] Hub down"))

    async def get_by_id(cid):
        return conversations.get(cid)

    async def get_all(_filter):
        return everyone

    async def messages_of(_filter):
        return messages

    async def self_ids():
        return {"me"}

    monkeypatch.setattr(approval.Conversation, "get_by_id", get_by_id)
    monkeypatch.setattr(approval.Conversation, "get_all", get_all)
    monkeypatch.setattr(approval.FlowMessage, "get_all", messages_of)
    monkeypatch.setattr(approval.User, "self_ids", self_ids)


_CLOCK = iter(range(1, 1000))


def _said(user_id, text):
    return SimpleNamespace(
        sender=MessageSender.user(user_id), text=text, occurred_at=datetime.fromtimestamp(next(_CLOCK), UTC)
    )


async def test_a_team_members_approve_lets_the_reply_go(monkeypatch):
    _world(monkeypatch, [_said("me", "proposal"), _said("dana", "Approve")])
    assert await approval.unapproved_reason(TICKET) == ""


@pytest.mark.parametrize("text", ["I do not approve this", "not approved - the refund is wrong", "should I approve?"])
async def test_a_message_that_merely_mentions_approve_is_not_approval(monkeypatch, text):
    _world(monkeypatch, [_said("me", "proposal"), _said("dana", text)])
    assert "not approved" in await approval.unapproved_reason(TICKET)


async def test_a_changed_proposal_needs_a_fresh_approve(monkeypatch):
    _world(monkeypatch, [_said("dana", "approve"), _said("me", "updated proposal")])
    assert "not approved" in await approval.unapproved_reason(TICKET)


async def test_the_agents_own_account_cannot_approve(monkeypatch):
    _world(monkeypatch, [_said("me", "approve")])
    assert "not approved" in await approval.unapproved_reason(TICKET)


async def test_a_team_member_who_has_not_approved_holds_the_reply(monkeypatch):
    _world(monkeypatch, [_said("dana", "please change the wording")])
    assert "not approved" in await approval.unapproved_reason(TICKET)


async def test_no_private_conversation_holds_the_reply(monkeypatch):
    _world(monkeypatch, [], private=False)
    assert "has not been asked" in await approval.unapproved_reason(TICKET)


async def test_a_conversation_that_is_not_a_ticket_is_not_held(monkeypatch):
    _world(monkeypatch, [], kind=ConversationKind.DIRECT)
    assert await approval.unapproved_reason(TICKET) == ""


async def test_a_conversation_message_carries_its_conversations_title_as_subject(monkeypatch):
    """The wake-up rule tells the private `[ticket …]` conversations by this subject."""
    import flow_sdk.stream_inbox.message_subject as ms
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.schema.data_spec.message_state_spec import MessageState

    async def message(_id):
        return SimpleNamespace()

    async def self_ids():
        return set()

    async def get_by_id(_cid):
        return SimpleNamespace(title="[ticket t1] Hub down")

    monkeypatch.setattr(ms, "_message", message)
    monkeypatch.setattr(ms, "_self_ids", self_ids)
    monkeypatch.setattr(ms, "state_of", lambda *_: MessageState(conversation_id="p1", text="approve"))
    monkeypatch.setattr(Conversation, "get_by_id", get_by_id)

    state = await ms.ConversationMessageSubject().of("flow_message:m1")

    assert state.subject == "[ticket t1] Hub down" and state.text == "approve"
