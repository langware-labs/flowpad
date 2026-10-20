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


async def _synth(prior: list | None = None) -> dict:
    """The synthesized notice's payload -- the hub embeds a target conversation but no
    ``preview_message``, so the synth branch runs -- given the invitation messages already there."""
    hub_inv = {"id": _INV_ID, "recipient_email": "dan@example.com", "accepted": False, "sent": True,
               "message": None, "conversation": {"id": _CONV_ID}}
    captured: dict = {}

    async def _capture(payload, **kwargs):
        captured.update(payload)
        return SimpleNamespace(typeid=f"flow_message-{payload.get('id')}", id=payload.get("id"))

    with (
        patch("flow_sdk.builtin.invitation.Invitation.get_one", new=AsyncMock(return_value=None)),
        patch("flow_sdk.builtin.invitation.Invitation.save",
              new=AsyncMock(return_value=SimpleNamespace(accepted=False, message=None))),
        patch("flow_sdk.app.actions.flow_message_action._upsert_hub_conversation_metadata", new=AsyncMock(return_value=None)),
        patch("flow_sdk.app.actions.flow_message_action.from_jsonl", new=MagicMock(return_value=MagicMock())),
        patch("flow_sdk.app.actions.materialize_flow_message.materialize_flow_message", new=_capture),
        # Announce step: keep it a no-op.
        patch("flow_sdk.app.actions.flow_message_action.Conversation.get_one", new=AsyncMock(return_value=None)),
        patch("flow_sdk.app.actions.flow_message_action.FlowMessage.get_all", new=AsyncMock(return_value=prior or [])),
    ):
        await _materialize_invitation(hub_inv, someone_typeid=None)
    assert captured, "synth branch did not run"
    return captured


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_synth_invite_notice_has_no_fabricated_identity():
    captured = await _synth()
    # No pretend-valid author anywhere.
    assert captured.get("created_by") is None
    assert captured.get("sender_id") is None
    assert captured.get("sender_name") is None
    # The honest placeholder is still produced.
    assert captured.get("kind") == "invitation"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_rerun_upserts_the_same_notice_found_by_its_invitation():
    """The notice is found by its natural key (this invitation, in this conversation), never re-minted."""
    from flow_sdk.api.api_types.identifier import is_valid_entity_id
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation

    first = (await _synth())["id"]
    assert is_valid_entity_id(first)
    other = SimpleNamespace(id="11111111-1111-4111-8111-111111111111", shared_context_entities=["local_invitation-x"])
    mine = SimpleNamespace(id=first, shared_context_entities=[f"{LocalInvitation.get_type()}-{_INV_ID}"])
    assert (await _synth([other, mine]))["id"] == first
