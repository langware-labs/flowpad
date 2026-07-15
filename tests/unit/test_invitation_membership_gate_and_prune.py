"""Invitation routing + expired-invitation pruning.

Regression tests for the "10 phantom Organization invitations" incident:
expired flow_message-share invitations sat in the inbox forever, mislabeled
as organization invitations.

Covered here:
  * ANY shareable entity type may be a ``target`` — a conversation-less
    targeted invitation routes to ``_materialize_membership_invitation``;
    an embedded conversation always wins and rides the thread path (riding
    asset grants must not hijack it).
  * ``_invitation_common_fields`` mirrors ``expiration_at`` (parsed to a real
    datetime) and the hub's ``inviter`` enrichment.
  * ``_prune_expired_invitations`` deletes expired, unaccepted, remote rows —
    and ONLY those.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk._compat import UTC
from flow_sdk.app.actions.flow_message_action import (
    _invitation_common_fields,
    _materialize_invitation,
    _prune_expired_invitations,
)

_INV_ID = "56abd4b9-16a1-4159-b359-b118eeb4bf86"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.parametrize(
    ("target_type", "with_conversation", "is_membership"),
    [
        # Conversation-less targeted invitations: ANY entity type routes to
        # the membership path and renders a generic "invited you to X" row.
        ("organization", False, True),
        ("workspace", False, True),
        ("flow_message", False, True),
        ("skill", False, True),
        # An embedded conversation always wins — a riding asset grant (the
        # skill attached to a conversation share) must not hijack the row.
        ("skill", True, False),
        ("organization", True, False),
    ],
)
async def test_target_routes_to_membership_path_only_without_conversation(
    target_type, with_conversation, is_membership
):
    hub_inv = {
        "id": _INV_ID,
        "recipient_email": "bob@langware.ai",
        "accepted": False,
        "sent": True,
        "target": {"type": target_type, "id": "9bd31dfd-8359-4860-8804-f44aef0b4d3e", "role": "reader"},
    }
    if with_conversation:
        hub_inv["conversation"] = {"id": "a591294e-e8ba-4ced-822b-98ea655f51b4"}
    membership_mock = AsyncMock(return_value=SimpleNamespace(id=_INV_ID))
    with (
        patch(
            "flow_sdk.app.actions.flow_message_action._materialize_membership_invitation",
            new=membership_mock,
        ),
        patch("flow_sdk.builtin.invitation.Invitation.get_one", new=AsyncMock(return_value=None)),
        patch(
            "flow_sdk.builtin.invitation.Invitation.save",
            # accepted=True stops the conversation path right after the
            # Invitation upsert — no conversation/jsonl machinery needed.
            new=AsyncMock(return_value=SimpleNamespace(accepted=True)),
        ),
    ):
        await _materialize_invitation(hub_inv, someone_typeid=None)

    assert membership_mock.called == is_membership


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_common_fields_mirror_expiration_and_inviter():
    fields = _invitation_common_fields(
        {
            "recipient_email": "Bob@Langware.AI",
            "accepted": False,
            "sent": True,
            "message": "hi",
            "expiration_at": "2026-07-02T11:26:37.242319+00:00",
            "inviter": {"user_id": "u-1", "name": "Gadi 20"},
        }
    )
    assert fields["recipient_email"] == "bob@langware.ai"
    assert fields["expiration_at"] == datetime(2026, 7, 2, 11, 26, 37, 242319, tzinfo=UTC)
    assert fields["sender_user_id"] == "u-1"
    assert fields["sender_name"] == "Gadi 20"

    # Absent / unparsable values degrade to None, never to a raw string
    # (assignment on a loaded entity is unvalidated — a str would poison
    # ``is_expired``).
    fields = _invitation_common_fields({"recipient_email": "a@b.c", "expiration_at": "not-a-date"})
    assert fields["expiration_at"] is None
    assert fields["sender_user_id"] is None
    assert fields["sender_name"] is None


def _local_inv(*, remote: bool, accepted: bool, expired: bool):
    delta = timedelta(days=-1) if expired else timedelta(days=1)
    inv = SimpleNamespace(
        id=_INV_ID,
        remote=remote,
        accepted=accepted,
        delete=AsyncMock(),
    )
    expiration_at = datetime.now(UTC) + delta
    inv.is_expired = lambda: datetime.now(UTC) > expiration_at
    return inv


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_prune_deletes_only_expired_unaccepted_remote_rows():
    dead = _local_inv(remote=True, accepted=False, expired=True)
    keep_live = _local_inv(remote=True, accepted=False, expired=False)
    keep_accepted = _local_inv(remote=True, accepted=True, expired=True)
    keep_local_only = _local_inv(remote=False, accepted=False, expired=True)

    rows = [dead, keep_live, keep_accepted, keep_local_only]
    with patch("flow_sdk.builtin.invitation.Invitation.get_all", new=AsyncMock(return_value=rows)):
        await _prune_expired_invitations()

    assert dead.delete.called
    assert not keep_live.delete.called
    assert not keep_accepted.delete.called
    assert not keep_local_only.delete.called
