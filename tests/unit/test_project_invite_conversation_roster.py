"""A project's invite conversation names its sender from the first save.

The row reaches the stream inbox while ``Conversation.share`` is still talking to the
hub — before the hub roster or the invite message exists — and with neither the
stream inbox's From cell read "Unknown". Only the network hops are stubbed.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.user import User

SHARER = {"user_id": "0a0a0a0a-0000-4000-8000-000000000001", "name": "Sharer", "email": "sharer@example.com"}


@pytest.mark.asyncio
async def test_invite_conversation_is_saved_with_the_sharer_before_it_is_shared(monkeypatch):
    seen_at_share: list = []

    async def sharer(cls, override_name=None):
        return dict(SHARER)

    async def fake_share(self, **_admit):
        # What the stream inbox renders during share(): the row as it is stored now.
        stored = await Conversation.get_one({"id": self.id})
        seen_at_share.append(list(stored.members or []))

    async def fake_add_message(*_args, **_kwargs):
        return None

    monkeypatch.setattr(User, "current_sender_participant", classmethod(sharer))
    monkeypatch.setattr(Conversation, "share", fake_share)
    monkeypatch.setattr("flow_sdk.app.actions.notification_action.handle_add_message", fake_add_message)

    conversation_id = await Project(name="lesson")._invite_conversation(None, "lesson", "hi", principals=["team-x"])

    assert seen_at_share == [[SHARER]]
    assert (await Conversation.get_one({"id": conversation_id})).members == [SHARER]
