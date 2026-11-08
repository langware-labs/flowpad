"""A share is never deleted once answered: every share arrives as an invite message in the 1:1
conversation with the person who shared, and that conversation and the Invitation stay as the record
of what was shared — Accepted, Declined, or No longer shared."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions import flow_message_action as fma
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage, FlowMessageKind
from flow_sdk.builtin.invitation import Invitation, conversation_target_path
from flow_sdk.cloud_client.hub_proxy import HubProxy, HubWalk
from flow_sdk.schema.data_spec.message_invite_spec import MessageInvite

_ID = "8d1f0c55-3a7e-4b8e-9a51-2f6a9c0b7d11"
_MACHINE = "e731bec3-f849-42a7-96a5-38cb3252fdfa"


def _share(**kw) -> Invitation:
    inv = Invitation.model_validate(
        {"id": _ID, "recipient_email": "me@example.com", "target_type": "compute_node",
         "target_id": _MACHINE, "target_name": "qa-cycle-manager", "remote": True, **kw}
    )
    object.__setattr__(inv, "save", AsyncMock(return_value=inv))
    object.__setattr__(inv, "delete", AsyncMock())
    return inv


def test_state_reads_rows_written_before_status():
    assert _share().state == "pending"
    assert _share(accepted=True).state == "accepted"
    assert _share(status="revoked", accepted=True).state == "revoked"


def test_the_invite_message_carries_the_share_and_drops_what_it_does_not_model():
    msg = FlowMessage(
        id=mint_uuid(),
        text="Shared compute node \"qa-cycle-manager\" with you.",
        kind=FlowMessageKind.INVITATION,
        invite={"invitation_id": _ID, "state": "accepted", "target_type": "compute_node", "target_id": _MACHINE,
                "target_name": "qa-cycle-manager", "roles": ["runner"], "future_hub_key": 1},
    )
    assert msg.invite == MessageInvite(invitation_id=_ID, state="accepted", target_type="compute_node",
                                       target_id=_MACHINE, target_name="qa-cycle-manager", roles=["runner"])


def test_the_hub_answer_is_mirrored_and_an_older_hub_blanks_nothing():
    answer = fma._invitation_answer_fields(
        {"status": "declined", "resolved_at": "2026-11-06T10:00:00Z",
         "target": {"type": "compute_node", "id": _MACHINE, "name": "qa", "roles": ["runner"]}}
    )
    assert answer["status"] == "declined" and answer["target_id"] == _MACHINE and answer["target_roles"] == ["runner"]
    assert fma._invitation_answer_fields({}) == {}


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.parametrize("threaded", [False, True])
async def test_decline_keeps_the_share_and_its_conversation(threaded):
    conv_id = mint_uuid()
    inv = _share(**({"target_url_path": conversation_target_path(conv_id), "message": f"conversation-{conv_id}"} if threaded else {}))
    with (
        patch("flow_sdk.cloud_client.transport.hub_http.hub_base_url", return_value="http://hub"),
        patch.object(fma, "_hub_decline_invitation", AsyncMock()),
        patch.object(Invitation, "get_one", AsyncMock(return_value=inv)),
        patch.object(fma, "_hard_delete_local_conversation", AsyncMock()) as hard_delete,
    ):
        await fma.handle_invitation_decline(_ID, "user-x")
    inv.delete.assert_not_awaited()
    hard_delete.assert_not_awaited()
    assert inv.state == "declined" and inv.resolved_at is not None


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_gone_share_is_marked_revoked_not_deleted():
    inv = _share(accepted=True)
    with patch.object(Invitation, "get_one", AsyncMock(return_value=inv)):
        res = await fma._self_heal_gone_invitation(_ID, context="test")
    assert res.status_code == 410
    inv.delete.assert_not_awaited()
    assert inv.state == "revoked"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_conversation_holding_invites_survives_the_hub_list_prune():
    """Declined or revoked, the person may be outside the thread on the hub; it stays here."""
    record = await Conversation(id=mint_uuid(), remote=True, title="Ishay", carries_invite=True).save()
    other = await Conversation(id=mint_uuid(), remote=True, title="gone").save()
    with (
        patch.object(HubProxy, "walk", new=AsyncMock(return_value=HubWalk(rows=[], complete=True))),
        patch.object(HubProxy, "try_call", new=AsyncMock(return_value=[])),
        patch.object(fma, "hub_base_url", return_value="https://hub.test"),
        patch("flow_sdk.cli.auth.hub_login.hub_auth_available", return_value=True),
    ):
        await fma.handle_conversation_list(SimpleNamespace(id=mint_uuid()))
    assert await Conversation.get_by_id(record.id) is not None
    assert await Conversation.get_by_id(other.id) is None


class _NoHub:
    """The bridge's hub client; these handlers never call it."""


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_machine_shared_with_me_is_mirrored_and_my_own_is_never_touched():
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.cloud_client.hub_bridge import HubWsBridge

    bridge = HubWsBridge(_NoHub())
    shared = mint_uuid()
    await bridge._handle_shared_machine_op("create", shared, {"name": "qa-cycle-manager", "node_size": "sm"})
    mirrored = await ComputeNode.get_by_id(shared)
    assert mirrored is not None and mirrored.remote is True and mirrored.name == "qa-cycle-manager"

    mine = await ComputeNode(id=mint_uuid(), name="my laptop").save()
    await bridge._handle_shared_machine_op("update", mine.id, {"name": "renamed by a push"})
    await bridge._handle_shared_machine_op("delete", mine.id, {})
    kept = await ComputeNode.get_by_id(mine.id)
    assert kept is not None and kept.name == "my laptop"

    await bridge._handle_shared_machine_op("delete", shared, {})
    assert await ComputeNode.get_by_id(shared) is None
