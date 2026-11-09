"""A help desk's turn text is sent back only until the agent has said something in the ticket."""

from flow_sdk.builtin.agent_serve import sends_turn_text, spoke_before


def test_a_ticket_the_agent_never_wrote_in_is_not_answered_before():
    assert spoke_before(["customer-1", "customer-1"], {"agent-1"}) is False
    assert spoke_before([], {"agent-1"}) is False


def test_a_ticket_with_a_message_of_ours_is_answered_before():
    assert spoke_before(["customer-1", "agent-1", "customer-1"], {"agent-1"}) is True


def test_a_missing_sender_is_nobody():
    assert spoke_before([None, ""], {"agent-1"}) is False


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
