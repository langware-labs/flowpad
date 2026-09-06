"""Settlement (`close` / `reopen`) on the local Conversation mirror.

The field these cover was free text with no verb behind it, so a ticket could be
"settled" into a value nothing recognised. These pin the two properties that
make the state mean something: only the two known values exist, and the value
travels so the other side hears about it.
"""

import pytest

from flow_sdk.builtin.conversation import Conversation, ConversationStatus


@pytest.mark.parametrize("value", ["open", "closed"])
def test_known_settlements_adopt(value):
    assert Conversation.model_validate({"status": value}).status == value


@pytest.mark.parametrize("value", ["banana", "resolved", "OPEN ", ""])
def test_unknown_settlement_is_refused(value):
    """A value no reader can act on is not a harmless annotation: every
    "is this closed?" check answers "no" to it, forever."""
    with pytest.raises(Exception):
        Conversation.model_validate({"status": value})


def test_settlement_defaults_to_open_and_travels():
    """A ticket awaits an answer until someone says otherwise — and `status`
    must be on the wire, or a close never leaves the machine that made it."""
    conv = Conversation()
    assert conv.status == ConversationStatus.OPEN
    assert "status" in conv.model_dump()
