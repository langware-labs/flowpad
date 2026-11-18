"""A help desk's turn text is sent back only until the agent has said something in the ticket."""

from flow_sdk.builtin.agent_serve import own_sender_ids, sends_turn_text, spoke_before
from flow_sdk.schema.data_spec.message_sender_spec import MessageSender

AGENT_ID = "9f379204-e729-4472-bb5a-4f6bb1a8c332"
OURS = own_sender_ids(AGENT_ID, {"local-user", "cloud-user"})
#: How an agent-owned source stamps the agent's own reply (the acknowledgement).
ACK = MessageSender.agent(AGENT_ID).wire_id


def test_a_ticket_the_agent_never_wrote_in_is_not_answered_before():
    assert spoke_before(["customer-1", "helpdesk:customer-1"], OURS) is False
    assert spoke_before([], OURS) is False


def test_the_agents_acknowledgement_counts_as_answered():
    """The agent's reply is stamped ``agent:<id>``, not with a user id: it must still count as ours, or
    every later turn's text (an internal summary) goes back to the customer."""
    assert spoke_before(["customer-1", "helpdesk:customer-1", ACK], OURS) is True


def test_another_agents_reply_is_not_ours():
    assert spoke_before([MessageSender.agent("someone-else").wire_id], OURS) is False


def test_a_missing_sender_is_nobody():
    assert spoke_before([None, ""], OURS) is False


class _Plain:
    pass


class _Explicit:
    replies_explicitly = True


class _Once:
    answers_once = True


def test_a_plain_source_always_sends_the_turn_text():
    assert sends_turn_text(_Plain, spoke=False) is True
    assert sends_turn_text(_Plain, spoke=True) is True


def test_an_explicit_source_never_sends_the_turn_text():
    assert sends_turn_text(_Explicit, spoke=False) is False


def test_a_source_that_answers_once_sends_the_turn_text_only_before_the_agent_spoke():
    assert sends_turn_text(_Once, spoke=False) is True
    assert sends_turn_text(_Once, spoke=True) is False
