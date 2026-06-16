"""Bug capture: sharing a conversation that was composed offline must deliver
its already-written messages to the hub.

Root cause (proven this session): the flow-diagnose support conversation is
created locally (``remote=False``) and its summary message is written through
the local pointer path, never ``add_message``'d. A normal conversation is remote
*before* its first message, so messages reach the hub at send time; this one
inverts the order, so the message is still local when ``share()`` runs. Before
the fix, ``share()`` pushed only the conversation shell + invitation and never
the pending message — the recipient opened an empty conversation.

The on/off switch is the ``await self._deliver_pending_messages()`` call in
``Conversation.share()``: with it, the pending message is pushed through the
normal send pipeline (``_send_conversation_message_header``); without it, it is
not. This test drives ``share()`` at the unit layer (hub I/O neutralized) and
asserts the pending message is delivered.
"""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk._compat import UTC


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_share_delivers_offline_composed_message_to_hub():
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.core import Entity
    from flow_sdk.fs_store.operations.conversation import (
        append_message_pointer,
        default_jsonl_path,
        from_jsonl,
    )
    from flow_sdk.fs_store.record_types import RecordType

    # A conversation + message composed offline: local-only, never hub-pushed.
    conv_id = str(uuid.uuid4())
    conv = Conversation.model_validate({"id": conv_id, "title": "Flowpad diagnostics"})
    conv.id = conv_id
    await conv.save()

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

    # Neutralize all hub I/O so the test is a pure unit on share()'s ordering:
    #   - super().share() (Entity.share) → no-op
    #   - credentials present
    #   - FlowpadClient (join + members POST) → async-context no-op
    #   - the normal-send hub create is the observation point
    creds = MagicMock(api_key="k", user={})

    @asynccontextmanager
    async def _fake_client(*_a, **_k):
        client = MagicMock()
        client.post = AsyncMock(return_value={})
        yield client

    header = AsyncMock(return_value=True)

    with (
        patch.object(Entity, "share", new=AsyncMock(return_value=None)),
        patch("flow_sdk.cli.auth.credentials.load_credentials", return_value=creds),
        patch("flow_sdk.cloud_client.client.FlowpadClient", side_effect=_fake_client),
        patch("flow_sdk.cloud_client.client.ApiConfig", MagicMock()),
        patch(
            "flow_sdk.app.actions.notification_action._send_conversation_message_header",
            header,
        ),
    ):
        await conv.share(recipients=["gadi@langware.ai"])

    # The bug's switch: with _deliver_pending_messages() in share(), the pending
    # offline message is pushed through the normal send pipeline. Without it,
    # this is never awaited and the recipient gets an empty conversation.
    header.assert_awaited_once()
    (_pushed_conv, pushed_fm), _ = header.call_args
    assert pushed_fm.id == msg.id, "share() must deliver the offline-composed message to the hub"
