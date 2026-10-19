"""A Conversation is who it is with: open one on a line (``DataSource.start``) and continue it
(``Conversation.send``) before anyone answers — addressed by ``Conversation.address``, not by whoever
wrote last. Over each channel's own ``Double``."""
from __future__ import annotations

import pytest

from flow_sdk.builtin.message_thread import MessageThread
from tests.unit._stream_inbox_matrix import double_for, make_cell

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval


@pytest.mark.parametrize("provider", ("whatsapp", "gmail"))
async def test_a_conversation_we_start_is_addressed_and_continued(provider, monkeypatch):
    with double_for(provider) as double:
        cell = await make_cell("user", provider, double, monkeypatch)
        try:
            before = len(double.sent())
            conversation = await cell.source.start(to=double.sender, body="Your order shipped.", subject="Order 42")
            assert conversation.address[0] == double.sender
            assert conversation.started_at is not None and conversation.ended_at is None
            assert str(conversation.channel_source_id) == str(cell.source.id)

            await conversation.send("It arrives tomorrow.")        # nobody has answered yet
            sent = double.sent()[before:]
            assert len(sent) == 2, sent
            threads = await MessageThread.get_all({"data_source_id": str(cell.source.id)})
            assert {str(t.conversation_id) for t in threads} == {str(conversation.id)}  # one conversation, not two
        finally:
            await cell.source.delete()
            await cell.agent.delete()
