"""Conversation delete vs. the hub's "nothing there for you" answer.

The Jul-6 prod incident shape: two archived conversations were really
never-accepted invitations. The hub rejected ``leave`` with
``401 Target entity not found(NR1)`` (the authorizer masks "no role" as
not-found) and the client aborted, leaving the rows stuck locally. These
tests pin the fixed semantics:

* hub says entity-missing/no-role on leave  → local delete proceeds, the
  linked invitation is declined (no zombie re-materialization),
* any other hub error                        → still a hard failure, local
  row kept,
* ``_classify_archived_delete`` matches invitation conversations by the
  ``target_url_path`` linkage (the ``message ==`` format is gone),
* ``_hard_delete_local_conversation`` cascades to FlowMessages through a
  valid QueryFilter (the ``conversation_id=`` kwarg used to raise
  ``extra_forbidden`` and silently leak every conversation's messages).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, Mock, patch

import pytest

from flow_sdk.app.actions.flow_message_action import (
    _classify_archived_delete,
    _find_invitation_for_conversation,
    _hard_delete_local_conversation,
    handle_conversation_delete,
)
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.invitation import Invitation, conversation_target_path
from flow_sdk.cloud_client.shared.errors import HubError, HubErrorCode

CONV_ID = "a9c55d90-ac56-4e1a-9f76-b753508bb7f0"
NR1 = HubError(
    401,
    "Missing request info(Target entity not found(NR1))",
    code=HubErrorCode.TARGET_NOT_FOUND.value,
)

_MOD = "flow_sdk.app.actions.flow_message_action"


def _conv(**over) -> Conversation:
    base = {"id": CONV_ID, "title": "t", "remote": True, "created_by": "someone-else"}
    base.update(over)
    return Conversation.model_validate(base)


def _inv(conv_id: str = CONV_ID, **over) -> Invitation:
    base = {
        "id": "bf224f58-8c51-42d8-8009-4fee43ee3b48",
        "recipient_email": "gadi@langware.ai",
        "target_url_path": conversation_target_path(conv_id),
        "accepted": False,
        "remote": True,
    }
    base.update(over)
    return Invitation.model_validate(base)


@pytest.fixture(autouse=True)
def _records_root(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path,
    )


async def _run_delete(mode: str, leave_error: Exception | None):
    """Drive handle_conversation_delete with the hub leave/delete mocked."""
    hub_call = AsyncMock(side_effect=leave_error) if leave_error else AsyncMock()
    hard_delete = AsyncMock()
    decline = AsyncMock()
    suppress = Mock()
    with (
        patch(f"{_MOD}.Conversation.get_one", new=AsyncMock(return_value=_conv())),
        patch(f"{_MOD}._hub_leave_conversation", new=hub_call),
        patch(f"{_MOD}._hub_delete_conversation", new=hub_call),
        patch(f"{_MOD}._hard_delete_local_conversation", new=hard_delete),
        patch(f"{_MOD}._decline_linked_invitation", new=decline),
        patch(
            "flow_sdk.cloud_client.hub_bridge.hub_ws_bridge.suppress_conversation_materialization",
            new=suppress,
        ),
        patch("flow_sdk.utils.hub.hub_base_url", return_value="https://hub.test"),
        patch(f"{_MOD}.hub_base_url", return_value="https://hub.test"),
    ):
        resp = await handle_conversation_delete(CONV_ID, mode, "user-x")
    return resp, hard_delete, decline, suppress


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_leave_nr1_still_deletes_locally_and_declines_invitation():
    resp, hard_delete, decline, suppress = await _run_delete("leave", NR1)
    assert resp.status == "SUCCESS"
    suppress.assert_called_once_with(CONV_ID)
    hard_delete.assert_awaited_once()
    decline.assert_awaited_once_with(CONV_ID)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_delete_for_all_404_still_deletes_locally():
    resp, hard_delete, _, suppress = await _run_delete("delete_for_all", HubError(404, "gone"))
    assert resp.status == "SUCCESS"
    suppress.assert_called_once_with(CONV_ID)
    hard_delete.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_real_hub_error_keeps_local_row():
    resp, hard_delete, decline, suppress = await _run_delete("leave", HubError(500, "boom"))
    assert resp.status == "FAIL"
    suppress.assert_not_called()
    hard_delete.assert_not_awaited()
    decline.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_classifier_matches_invitation_by_target_url_path():
    with patch.object(Invitation, "get_all", new=AsyncMock(return_value=[_inv()])):
        assert await _classify_archived_delete(_conv(), "my-user") == "decline_invitation"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_classifier_accepted_invitation_falls_through_to_leave():
    with patch.object(Invitation, "get_all", new=AsyncMock(return_value=[_inv(accepted=True)])):
        assert await _classify_archived_delete(_conv(), "my-user") == "leave"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_find_invitation_ignores_other_conversations():
    other = _inv(conv_id="00000000-0000-4000-8000-000000000000")
    with patch.object(Invitation, "get_all", new=AsyncMock(return_value=[other])):
        assert await _find_invitation_for_conversation(CONV_ID) is None


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_hard_delete_cascades_flow_messages_with_valid_filter():
    fm = AsyncMock(spec=FlowMessage)
    captured: list = []

    async def fake_get_all(flt):
        captured.append(flt)
        return [fm]

    conv = _conv()
    with (
        patch.object(FlowMessage, "get_all", new=AsyncMock(side_effect=fake_get_all)),
        patch.object(Conversation, "delete", new=AsyncMock()),
    ):
        await _hard_delete_local_conversation(conv)

    assert len(captured) == 1  # the filter built without a ValidationError
    flt = captured[0]
    assert flt.type == "flow_message"
    assert flt.match.operands == ["conversation_id", CONV_ID]
    fm.delete.assert_awaited_once()
