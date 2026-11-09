"""A help desk's turn text is sent back only until the agent has said something in the ticket."""

from flow_sdk.builtin.agent_serve import spoke_before


def test_a_ticket_the_agent_never_wrote_in_is_not_answered_before():
    assert spoke_before(["customer-1", "customer-1"], {"agent-1"}) is False
    assert spoke_before([], {"agent-1"}) is False


def test_a_ticket_with_a_message_of_ours_is_answered_before():
    assert spoke_before(["customer-1", "agent-1", "customer-1"], {"agent-1"}) is True


def test_a_missing_sender_is_nobody():
    assert spoke_before([None, ""], {"agent-1"}) is False
