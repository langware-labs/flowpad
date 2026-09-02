"""Who a channel reply is addressed to.

The bug this pins was found live: a reply sent from the UI arrived back in our
own mailbox. Our sent copies are ingested into the same thread, so "the newest
message in this conversation" is frequently one we wrote — and replying to that
one mails us instead of the correspondent.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.inbox.outbound import ChannelSendUnavailable, resolve_reply_target

LOCAL_USER_ID = "9f0b1c2d-3e4f-4a5b-8c7d-6e5f4a3b2c1d"
AGENT_ID = "5a1c9e77-0b2d-4f6a-9c3e-1d8b7a6f5e4c"
AGENT_SENDER = f"agent:{AGENT_ID}"
CONVERSATION = "023f16d6-ba1d-5f8b-8337-78bf9a2e9264"


def _message(sender_id: str, item_id: str, kind: str = "agentmail", source_id: str = "ds-1"):
    # Two halves, mirroring the entity: `origin` travels, `origin_local` does not.
    return SimpleNamespace(
        sender_id=sender_id,
        origin=SimpleNamespace(kind=kind),
        origin_local=SimpleNamespace(data_source_id=source_id, source_item_id=item_id),
    )


def _shared_message(sender_id: str, kind: str = "agentmail"):
    return SimpleNamespace(
        sender_id=sender_id,
        origin=SimpleNamespace(kind=kind),
        origin_local=None,
    )


def _item(item_id: str, author: str, subject: str):
    return SimpleNamespace(
        id=item_id, author_external_id=author, name=subject,
        thread_key="t-1", external_id=f"<{item_id}@mail>",
    )


@pytest.fixture
def wire(monkeypatch):
    """Stub the four reads `resolve_reply_target` makes."""
    state: dict = {"messages": [], "items": {}, "sends": True, "source": SimpleNamespace(
        id="ds-1", provider="agentmail", config={}),
        # Overridable so a test can run with NO local user row — the state a
        # process that never ran bootstrap is actually in.
        "local": SimpleNamespace(id=LOCAL_USER_ID)}

    async def _get_all(_query):
        return state["messages"]

    async def _get_local():
        return state["local"]

    async def _source_one(_q):
        return state["source"]

    async def _item_one(query):
        return state["items"].get(query.get("id"))

    monkeypatch.setattr("flow_sdk.builtin.flow_message.FlowMessage.get_all", _get_all)
    monkeypatch.setattr("flow_sdk.builtin.user.User.get_local", _get_local)
    monkeypatch.setattr("flow_sdk.builtin.data_source.DataSource.get_one", _source_one)
    monkeypatch.setattr("flow_sdk.builtin.source_item.SourceItem.get_one", _item_one)
    monkeypatch.setattr(
        "flow_sdk.ingest.driver.get_driver",
        lambda _p: SimpleNamespace(sends=state["sends"]),
    )
    return state


class TestItRepliesToTheCorrespondent:
    @pytest.mark.asyncio
    async def test_our_own_newest_message_is_skipped(self, wire):
        # Newest first: our sent copy, then the mail we are actually answering.
        wire["messages"] = [
            _message(LOCAL_USER_ID, "mine"),
            _message("agentmail:joe@agentmail.to", "theirs"),
        ]
        wire["items"] = {
            "mine": _item("mine", "eran-1968@agentmail.to", "Re: Round trip"),
            "theirs": _item("theirs", "joe@agentmail.to", "Round trip"),
        }
        target = await resolve_reply_target(CONVERSATION)

        # The whole point. Addressing "mine" would mail us our own reply.
        assert target.to == "joe@agentmail.to"
        assert target.in_reply_to == "<theirs@mail>"

    @pytest.mark.asyncio
    async def test_the_newest_inbound_wins_not_the_oldest(self, wire):
        wire["messages"] = [
            _message(LOCAL_USER_ID, "mine"),
            _message("agentmail:newer@x.to", "newer"),
            _message("agentmail:older@x.to", "older"),
        ]
        wire["items"] = {
            "mine": _item("mine", "me@x.to", "Re: x"),
            "newer": _item("newer", "newer@x.to", "x"),
            "older": _item("older", "older@x.to", "x"),
        }
        assert (await resolve_reply_target(CONVERSATION)).to == "newer@x.to"

    @pytest.mark.asyncio
    async def test_a_thread_only_we_have_written_in_refuses(self, wire):
        # No recipient is recorded anywhere for a thread we started. Guessing
        # one is how a reply reaches the wrong person, so refuse instead.
        wire["messages"] = [_message(LOCAL_USER_ID, "mine")]
        wire["items"] = {"mine": _item("mine", "me@x.to", "Hello")}
        with pytest.raises(ChannelSendUnavailable, match="no one else"):
            await resolve_reply_target(CONVERSATION)

    @pytest.mark.asyncio
    async def test_agent_scope_ignores_a_newer_message_from_another_source(self, wire):
        wire["messages"] = [
            _message("agentmail:wrong@x.to", "wrong", source_id="ds-2"),
            _message("agentmail:right@x.to", "right", source_id="ds-1"),
        ]
        wire["items"] = {
            "wrong": _item("wrong", "wrong@x.to", "x"),
            "right": _item("right", "right@x.to", "x"),
        }

        target = await resolve_reply_target(CONVERSATION, source_id="ds-1")

        assert target.source.id == "ds-1"
        assert target.to == "right@x.to"


class TestItRefusesRatherThanGuess:
    @pytest.mark.asyncio
    async def test_a_conversation_with_no_channel_origin(self, wire):
        wire["messages"] = [SimpleNamespace(sender_id="x", origin=None, origin_local=None)]
        with pytest.raises(ChannelSendUnavailable, match="did not come from a channel"):
            await resolve_reply_target(CONVERSATION)

    @pytest.mark.asyncio
    async def test_a_transport_that_cannot_send(self, wire):
        wire["sends"] = False
        wire["messages"] = [_message("agentmail:joe@x.to", "theirs")]
        wire["items"] = {"theirs": _item("theirs", "joe@x.to", "x")}
        with pytest.raises(ChannelSendUnavailable, match="cannot send"):
            await resolve_reply_target(CONVERSATION)

    @pytest.mark.asyncio
    async def test_a_sender_with_no_address(self, wire):
        wire["messages"] = [_message("agentmail:anon", "theirs")]
        wire["items"] = {"theirs": _item("theirs", "", "x")}
        with pytest.raises(ChannelSendUnavailable, match="no sender address"):
            await resolve_reply_target(CONVERSATION)

    @pytest.mark.asyncio
    async def test_a_missing_record_is_not_reported_as_a_missing_address(self, wire):
        wire["messages"] = [_message("agentmail:joe@x.to", "gone")]
        wire["items"] = {}
        with pytest.raises(ChannelSendUnavailable, match="record this arrived through is gone"):
            await resolve_reply_target(CONVERSATION)

    @pytest.mark.asyncio
    async def test_a_message_shared_from_another_machine(self, wire):
        """FOREIGN is not GONE, and the refusal has to say which.

        A received message keeps `origin` (SHARED — that is what draws its badge)
        and never carries `origin_local`, whose row ids only resolve on the
        machine that ingested it. Before the split those ids travelled, so the
        receiver dereferenced them, missed, and reported a record that was alive
        and elsewhere as deleted.
        """
        wire["messages"] = [_shared_message("agentmail:joe@x.to")]
        wire["items"] = {}
        with pytest.raises(ChannelSendUnavailable, match="shared from another machine"):
            await resolve_reply_target(CONVERSATION)


class TestItKnowsBothOfOurIdentities:
    """An agent's mailbox is ours too, even though it is not the local user.

    ``_sender_for`` deliberately stamps an agent's own sent copies with
    ``agent:<id>`` rather than the human's id, so the owner does not appear to
    have written replies they never saw. A reply resolver that knows only the
    user id therefore reads those copies as a stranger — and since the recipient
    IS the target message's sender, the agent ends up mailing itself.
    """

    @pytest.mark.asyncio
    async def test_an_agents_own_sent_copy_is_not_a_correspondent(self, wire):
        # Newest first: the agent's own reply, then the mail it was answering.
        wire["messages"] = [
            _message(AGENT_SENDER, "agent_reply"),
            _message("agentmail:joe@agentmail.to", "theirs"),
        ]
        wire["items"] = {
            "agent_reply": _item("agent_reply", "bot@agentmail.to", "Re: Ping"),
            "theirs": _item("theirs", "joe@agentmail.to", "Ping"),
        }
        target = await resolve_reply_target(CONVERSATION)

        assert target.to == "joe@agentmail.to", "the agent addressed its own mailbox"

    @pytest.mark.asyncio
    async def test_a_thread_only_the_agent_has_written_in_refuses(self, wire):
        wire["messages"] = [_message(AGENT_SENDER, "agent_only")]
        wire["items"] = {"agent_only": _item("agent_only", "bot@agentmail.to", "Hello")}

        with pytest.raises(ChannelSendUnavailable):
            await resolve_reply_target(CONVERSATION)


class TestAnUnknownLocalUserIsNotEveryone:
    """No local user means "we cannot identify ourselves", not "all of this is ours".

    Bootstrap creates the row, so this is the state of any process that has not
    run it. Folding the two together made every message look like ours and the
    resolver refuse with "no one else has written in this thread yet" — a thread
    full of strangers described as a thread full of us.
    """

    @pytest.mark.asyncio
    async def test_an_external_message_still_resolves(self, wire):
        wire["local"] = None
        wire["messages"] = [_message("agentmail:joe@agentmail.to", "theirs")]
        wire["items"] = {"theirs": _item("theirs", "joe@agentmail.to", "Ping")}

        assert (await resolve_reply_target(CONVERSATION)).to == "joe@agentmail.to"

    @pytest.mark.asyncio
    async def test_an_agents_own_copy_is_still_ours_without_a_local_user(self, wire):
        # The agent id is ours by construction, so this check stands alone —
        # it does not depend on a user row being present to compare against.
        wire["local"] = None
        wire["messages"] = [_message(AGENT_SENDER, "agent_only")]
        wire["items"] = {"agent_only": _item("agent_only", "bot@agentmail.to", "Hello")}

        with pytest.raises(ChannelSendUnavailable):
            await resolve_reply_target(CONVERSATION)
