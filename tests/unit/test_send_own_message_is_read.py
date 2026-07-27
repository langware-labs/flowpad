"""Sender's own outgoing message must NOT leave the conversation unread.

Repro for the reported bug: *sending a message with an attachment marks the
conversation as unread upon send.* The inbox row's unread state is derived
purely from the latest message's ``is_read`` flag
(``conversation-category.ts``: ``isUnread = !latestMessage.is_read``) with no
exclusion for messages the viewer sent themselves. So the sender's own
just-sent message — which *is* the latest message — must be persisted
``is_read=True``, otherwise the sender sees their own conversation go unread.

``handle_add_message`` builds the sender's reply via ``_build_reply_flow_message``
which never stamps ``is_read``, so it defaults to ``False`` — the bug. These
tests drive the real send handler (real entities, real fs_store persistence, no
mocks, offline / local conversation) for the two cases the report calls out:
a FRESH conversation and an EXISTING conversation, each WITH an attachment.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.app.actions.notification_action import handle_add_message
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.fs_store.record_paths import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)

_SENDER = f"user-{uuid.uuid4()}"


class _UploadFile:
    """Minimal Starlette-UploadFile stand-in: ``.filename`` + async ``.read()``.

    This is NOT a mock of the code under test — it is the real shape the send
    handler consumes for an attachment (``_attach_uploaded_files`` only needs
    ``.read()``/``.filename``); the FlowMessage build + persistence run for real.
    """

    def __init__(self, name: str, data: bytes):
        self.filename = name
        self._data = data

    async def read(self) -> bytes:
        return self._data


@pytest.fixture
def records_root(tmp_path):
    orig_root = get_default_records_root()
    orig_data = get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    try:
        yield tmp_path
    finally:
        set_default_records_root(orig_root)
        set_default_records_data_root(orig_data)


async def _make_conversation(*, with_prior_message: bool) -> str:
    conv_id = str(uuid.uuid4())
    conv = Conversation.model_validate({"id": conv_id, "remote": False})
    await conv.save(None)
    if with_prior_message:
        # An already-established conversation: one message already exists.
        await handle_add_message(
            {"conversation_id": conv_id, "message": "earlier message"}, _SENDER
        )
    return conv_id


async def _send_with_attachment(conv_id: str) -> str:
    resp = await handle_add_message(
        {
            "conversation_id": conv_id,
            "message": "here is a file",
            "files": [_UploadFile("note.txt", b"attachment bytes")],
        },
        _SENDER,
    )
    data = resp.data if hasattr(resp, "data") else resp.get("data")
    fm_id = (data or {}).get("id") or (data or {}).get("flow_message_id")
    assert fm_id, f"send did not return a flow_message id: {data!r}"
    return fm_id


async def _assert_sender_row_not_unread(fm_id: str) -> None:
    fm = await FlowMessage.get_one({"id": fm_id})
    assert fm is not None
    # The frontend row unread state is exactly ``!latestMessage.is_read``. The
    # sender authored this message, so from their side it is read — the row must
    # NOT be unread. This is the assertion that reproduces the bug: it is
    # currently False, so the sender's conversation goes unread on send.
    assert fm.is_read is True, (
        "sender's own just-sent message persisted is_read=False → the "
        "conversation shows as unread to the sender"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_fresh_conversation_send_with_attachment_stays_read(records_root):
    conv_id = await _make_conversation(with_prior_message=False)
    fm_id = await _send_with_attachment(conv_id)
    await _assert_sender_row_not_unread(fm_id)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_existing_conversation_send_with_attachment_stays_read(records_root):
    conv_id = await _make_conversation(with_prior_message=True)
    fm_id = await _send_with_attachment(conv_id)
    await _assert_sender_row_not_unread(fm_id)
