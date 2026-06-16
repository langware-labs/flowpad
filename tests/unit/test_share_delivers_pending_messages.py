"""Regression: a conversation composed offline (the flow-diagnose support
artifact) carries messages written through the local pointer path while
``remote=False``. When it is later shared, ``share()`` must flush those messages
through the SAME send pipeline a normal reply uses, so recipients don't open an
empty conversation.

Normal conversations never hit this — they are remote before their first
message, so every message reaches the hub at send time. This test pins the
offline-then-shared ordering specifically.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk._compat import UTC


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_share_flushes_pending_local_message_via_normal_send_pipeline():
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.fs_store.operations.conversation import (
        append_message_pointer,
        default_jsonl_path,
        from_jsonl,
    )
    from flow_sdk.fs_store.record_types import RecordType

    conv_id = str(uuid.uuid4())
    conv = Conversation.model_validate({"id": conv_id, "title": "Flowpad diagnostics"})
    conv.id = conv_id
    await conv.save()

    # A message written through the local pointer path while the conversation
    # was still local — remote defaults to False, exactly like report.py.
    msg = FlowMessage(
        text="diagnostics body",
        conversation_id=conv_id,
        sender_id="local-user",
        sender_name="Ami Levy",
    )
    await msg.save()
    rec = from_jsonl(default_jsonl_path(conv_id), conv_id, conv_id, parent_type=RecordType.PROJECT)
    rec.save()
    append_message_pointer(rec, msg.id, datetime.now(UTC).isoformat())

    # Reuse the normal-send hub functions (patched so the test stays offline) and
    # assert the pending message is delivered through them.
    header = AsyncMock(return_value=True)
    upload = AsyncMock(return_value=None)
    with (
        patch("flow_sdk.app.actions.notification_action._send_conversation_message_header", header),
        patch("flow_sdk.app.actions.notification_action._upload_body_and_finalize", upload),
    ):
        await conv._deliver_pending_messages()

    header.assert_awaited_once()
    (pushed_conv, pushed_fm), _ = header.call_args
    assert pushed_conv.id == conv_id
    assert pushed_fm.id == msg.id
    # The message is now marked mirrored so a re-share doesn't double-push.
    stored = await FlowMessage.get_one({"id": msg.id})
    assert stored is not None and stored.remote is True

    # Second share is a no-op for the already-mirrored message.
    header2 = AsyncMock(return_value=True)
    with patch("flow_sdk.app.actions.notification_action._send_conversation_message_header", header2):
        await conv._deliver_pending_messages()
    header2.assert_not_awaited()
