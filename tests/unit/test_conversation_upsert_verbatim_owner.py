"""``_upsert_hub_conversation_metadata`` carries the hub owner verbatim.

A share-created conversation carries no ``initiated_by`` on the hub. The local
reflection must therefore land ``created_by = None`` — NOT the 'system' sentinel
and NOT the local sync user. Ownership for display resolves from the participant
roster's ``owner`` role. When the hub DOES carry ``initiated_by``, it is mirrored
verbatim.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions.flow_message_action import _upsert_hub_conversation_metadata
from flow_sdk.builtin.conversation import Conversation


_CONV_ID = "a591294e-e8ba-4ced-822b-98ea655f51b4"


async def _upsert_capture(hub_conv: dict):
    captured = {}

    async def _capture_save(self, *args, **kwargs):
        captured["created_by"] = self.created_by
        return self

    with (
        patch.object(Conversation, "get_one", new=AsyncMock(return_value=None)),
        patch.object(Conversation, "save", new=_capture_save),
    ):
        await _upsert_hub_conversation_metadata(hub_conv, someone_typeid=None, notify=False)
    return captured["created_by"]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_share_created_conv_owner_stays_null():
    created_by = await _upsert_capture(
        {"id": _CONV_ID, "title": "Flowpad diagnostics", "participants": []},
    )
    assert created_by is None


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_hub_owner_mirrored_verbatim():
    created_by = await _upsert_capture(
        {"id": _CONV_ID, "title": "Project conv", "initiated_by": "49420c72-owner-id"},
    )
    assert created_by == "49420c72-owner-id"
