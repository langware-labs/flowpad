"""The Classify count's rule (``flow_sdk.stream_inbox.unclassified_ids``): a conversation of the stream inbox
whose newest message carries no tag from the classification tree waits for one. Pure: entities in, ids out."""

import json
from datetime import datetime, timezone
from types import SimpleNamespace

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.stream_inbox import unclassified_ids

ME = TypeId("user-11111111-1111-4111-8111-111111111111")


def conversation(cid: str, day: int, **more) -> Conversation:
    pointers = [{"typeid": f"flow_message-old-{cid}", "ts": "2026-11-01T00:00:00Z"},
                {"typeid": f"flow_message-{cid}", "ts": f"2026-11-{day:02d}T00:00:00Z"}]
    return Conversation(id=cid, message_ids=json.dumps(pointers), **more)


def test_a_conversation_waits_while_its_newest_message_has_no_tag_of_the_tree():
    conversations = [
        conversation("older", 10), conversation("newer", 12),
        conversation("tagged", 13),
        conversation("other-tree", 11),
        conversation("archived", 14, archived_at=datetime(2026, 11, 20, tzinfo=timezone.utc)),
        conversation("automation", 15, channel="automations"),
        conversation("invited", 16),
        conversation("theirs", 17, owner=TypeId("user-22222222-2222-4222-8222-222222222222")),
    ]
    tags = {"tagged": ["stream_inbox.support.billing"], "other-tree": ["crm.lead"]}
    messages = {c.id: SimpleNamespace(id=c.id, tags=tags.get(c.id, [])) for c in conversations}
    waiting = unclassified_ids(conversations=conversations, fm_by_id=messages, root="stream_inbox",
                               pending_conv_ids={"invited"}, stream_inbox_owner=ME)
    assert waiting == ["newer", "other-tree", "older"]   # newest first: a run takes the first ones
