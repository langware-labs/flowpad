"""The synthesized invite-notice must carry NO fabricated identity.

When the hub embeds a target conversation but no ``preview_message``, the
receiver synthesizes an invitation-kind FlowMessage so the UI shows the
invitation row. That placeholder must NOT pretend to have a valid author:
``created_by`` / ``sender_id`` / ``sender_name`` stay absent (null), so the UI
honestly renders "unknown" instead of a 'system' sentinel or a guessed inviter.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.app.actions.flow_message_action import _materialize_invitation


_INV_ID = "56abd4b9-16a1-4159-b359-b118eeb4bf86"
_CONV_ID = "a591294e-e8ba-4ced-822b-98ea655f51b4"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_synth_invite_notice_has_no_fabricated_identity():
    hub_inv = {
        "id": _INV_ID,
        "recipient_email": "eran@langware.ai",
        "accepted": False,
        "sent": True,
        "message": None,
        "conversation": {"id": _CONV_ID},
        # NOTE: no "preview_message" → forces the synth branch.
    }

    fake_inv = SimpleNamespace(accepted=False, message=None)
    captured = {}

    async def _capture_materialize(payload, **kwargs):
        captured.update(payload)
        return SimpleNamespace(
            typeid=f"flow_message-{payload.get('id')}", id=payload.get("id")
        )

    with (
        patch("flow_sdk.builtin.invitation.Invitation.get_one", new=AsyncMock(return_value=None)),
        patch("flow_sdk.builtin.invitation.Invitation.save", new=AsyncMock(return_value=fake_inv)),
        patch(
            "flow_sdk.app.actions.flow_message_action._upsert_hub_conversation_metadata",
            new=AsyncMock(return_value=None),
        ),
        patch("flow_sdk.app.actions.flow_message_action.from_jsonl", new=MagicMock(return_value=MagicMock())),
        patch(
            "flow_sdk.app.actions.materialize_flow_message.materialize_flow_message",
            new=_capture_materialize,
        ),
        # Announce step: keep it a no-op.
        patch("flow_sdk.app.actions.flow_message_action.Conversation.get_one", new=AsyncMock(return_value=None)),
    ):
        await _materialize_invitation(hub_inv, someone_typeid=None)

    assert captured, "synth branch did not run"
    # No pretend-valid author anywhere.
    assert captured.get("created_by") is None
    assert captured.get("sender_id") is None
    assert captured.get("sender_name") is None
    # The honest placeholder is still produced.
    assert captured.get("kind") == "invitation"
