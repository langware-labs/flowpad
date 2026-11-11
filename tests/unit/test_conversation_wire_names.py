"""A conversation's fields have one name on the hub and here — nothing is renamed on the way in.

The hub sends the roster as ``members`` and the owner as ``initiated_by``; the desktop keeps them under
the same names. A rename (``hub_name``) on a conversation field would bring back the translation layer
that hid the roster under ``participants``.
"""

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.serializer.hub import hub_names

# A conversation list row as the hub sends it (flowpad/hub/builtin/conversation.py ``read_with_roster``).
HUB_ROW = {
    "id": "c-wire-names",
    "type": "conversation",
    "title": "Wire names",
    "kind": "direct",
    "status": "open",
    "initiated_by": "owner-1",
    "created_by": "creator-1",
    "message_count": 2,
    "members": [
        {"user_id": "owner-1", "name": "Alice", "role": "owner"},
        {"user_id": "u-2", "name": "Bob", "role": "member"},
    ],
}


def test_a_conversation_adds_no_rename_of_its_own():
    # Only what every entity inherits (``origin`` is the hub's ``git_origin``) — nothing conversation-specific.
    assert hub_names(Conversation) == hub_names(Entity)


def test_a_hub_row_lands_under_its_own_names():
    landed = Conversation.accepted_from_hub(HUB_ROW)
    assert landed["members"] == HUB_ROW["members"]
    assert landed["initiated_by"] == "owner-1"
    # ``created_by`` is this row's own attribution, never the hub's owner.
    assert "created_by" not in landed


def test_the_old_roster_key_is_not_read():
    old = {k: v for k, v in HUB_ROW.items() if k != "members"} | {"participants": HUB_ROW["members"]}
    assert "members" not in Conversation.accepted_from_hub(old)
