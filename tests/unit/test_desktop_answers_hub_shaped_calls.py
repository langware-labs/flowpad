"""The desktop answers the hub's own calls, so one SDK call works against either server.

* ``POST <type>/<id>/members`` (a ``MembershipRequest``) on a row held here is answered here: a
  conversation admits through ``Conversation.share``; any other row is published first when the
  hub lacks it, then the request is forwarded unchanged; ``members/link`` mints after publishing.
* ``POST conversation/<id>/leave`` and ``DELETE conversation/<id>/delete`` run the hub's action,
  then drop the local copy (a conversation that never reached the hub is deleted locally).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions import members_action
from flow_sdk.app.actions.flow_message_action import conversation_leave, conversation_owner_delete
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.server.routes._hub_reflect import GraphPath, _admits_locally

CONV_ID = "a9c55d90-ac56-4e1a-9f76-b753508bb7f0"
_FM = "flow_sdk.app.actions.flow_message_action"


def _request(body: dict, sub_path: str | None = None):
    return SimpleNamespace(
        method="POST",
        sub_path=sub_path,
        someone_typeid="user-x",
        get_post_data=AsyncMock(return_value=body),
    )


def _row(type_: str, remote: bool):
    return SimpleNamespace(type=type_, id=CONV_ID, remote=remote, members=[], share=AsyncMock())


def test_an_invitation_into_a_row_held_here_is_answered_here():
    held = _row("conversation", remote=True)
    assert _admits_locally("POST", GraphPath("conversation", CONV_ID, ["members"]), held)
    assert _admits_locally("post", GraphPath("project", CONV_ID, ["members", "link"]), held)
    assert not _admits_locally("GET", GraphPath("conversation", CONV_ID, ["members"]), held)
    assert not _admits_locally("POST", GraphPath("conversation", CONV_ID, ["members", "redeem"]), held)
    assert not _admits_locally("POST", GraphPath("conversation", CONV_ID, ["members"]), None)


async def _invite(row, body: dict, sub_path: str | None = None):
    hub_call = AsyncMock(return_value={"url": "https://hub.test/l/abc"})
    with (
        patch.object(members_action, "get_current_request_info", return_value=_request(body, sub_path)),
        patch.object(members_action, "_can_reach_hub", return_value=True),
        patch.object(members_action, "_refresh_roster", new=AsyncMock(return_value=[{"email": "b@x.test"}])),
        patch("flow_sdk.cloud_client.hub_proxy.HubProxy.call", new=hub_call),
    ):
        resp = await members_action.members(row)
    return resp, hub_call


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_conversation_admits_through_its_share():
    row = _row("conversation", remote=True)
    resp, hub_call = await _invite(row, {"recipient_user_id": "u-1", "invitation_targets": []})
    assert resp.status == "SUCCESS" and resp.data == [{"email": "b@x.test"}]
    row.share.assert_awaited_once_with(
        recipients=None, recipient_user_ids=["u-1"], principals=None, notify_by_email=True,
        invitation={"invitation_targets": []},
    )
    hub_call.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_conversation_invite_keeps_every_field_the_caller_sent():
    """Role, message, expiry, an ownership transfer: all ride to ``share`` as the invitation."""
    row = _row("conversation", remote=True)
    body = {
        "recipient_email": " b@x.test ", "role": "owner", "message": "hi", "expiration_at": "2026-11-01",
        "role_to_keep": "member", "callback_override": "/x", "notify_by_email": False,
    }
    await _invite(row, body)
    row.share.assert_awaited_once_with(
        recipients=["b@x.test"], recipient_user_ids=None, principals=None, notify_by_email=False,
        invitation={"role": "owner", "message": "hi", "expiration_at": "2026-11-01", "role_to_keep": "member",
                    "callback_override": "/x"},
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_non_string_recipient_is_a_400_not_a_crash():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        await _invite(_row("conversation", remote=True), {"recipient_email": ["b@x.test"]})
    assert e.value.status_code == 400


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_signed_out_share_answers_a_fail_not_a_500():
    row = _row("conversation", remote=True)
    row.share = AsyncMock(side_effect=RuntimeError("Cloud login required"))
    resp, _ = await _invite(row, {"recipient_email": "b@x.test"})
    assert resp.status == "FAIL" and resp.status_code == 401


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_an_invite_without_the_hub_fails_loudly():
    from fastapi import HTTPException

    with (
        patch.object(members_action, "get_current_request_info", return_value=_request({"recipient_email": "b@x.test"})),
        patch.object(members_action, "_can_reach_hub", return_value=False),
        pytest.raises(HTTPException) as e,
    ):
        await members_action.members(_row("conversation", remote=True))
    assert e.value.status_code == 409


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_share_puts_the_callers_invitation_on_the_hub_body(monkeypatch):
    """``Conversation.share(invitation=...)``: the role lands on the conversation target, extra
    targets follow it, everything else is sent as given; a row already on the hub is not re-created."""
    from tests.utils.hub_proxy_fake import FakeHub

    conv = Conversation.model_validate({"id": CONV_ID, "title": "t", "remote": True})
    hub = FakeHub().on("POST", "conversation", CONV_ID, action="join").on("POST", "conversation", CONV_ID, action="members")
    hub.install(monkeypatch)
    monkeypatch.setattr("flow_sdk.cli.auth.credentials.load_credentials", lambda: SimpleNamespace(api_key="k"))
    for name in ("_link_context_to_conversation", "deliver", "kick_delivery"):
        monkeypatch.setattr(Conversation, name, AsyncMock() if name != "kick_delivery" else (lambda self: None))
    monkeypatch.setattr(Conversation, "_share_hostable_assets", AsyncMock(return_value=[]))
    monkeypatch.setattr(Conversation, "_first_message_landing_path", lambda self: "/first")
    create = AsyncMock()
    monkeypatch.setattr("flow_sdk.core.entity.entity_model.Entity.share", create)

    await conv.share(
        recipients=["b@x.test"],
        invitation={"role": "owner", "message": "hi", "role_to_keep": "member", "callback_override": "/mine",
                    "invitation_targets": [{"typeid": "skill-1", "role": "reader"}]},
    )

    create.assert_not_awaited()
    (invite,) = hub.called("POST", "conversation", CONV_ID, action="members")
    assert invite.payload == {
        "recipient_email": "b@x.test",
        "invitation_targets": [{"typeid": f"conversation-{CONV_ID}", "role": "owner"}, {"typeid": "skill-1", "role": "reader"}],
        "callback_override": "/mine", "message": "hi", "role_to_keep": "member",
    }


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_another_row_is_published_first_then_the_request_goes_to_the_hub_unchanged():
    row = _row("task", remote=False)
    body = {"recipient_email": "b@x.test", "invitation_targets": [{"typeid": f"task-{CONV_ID}", "role": "member"}]}
    resp, hub_call = await _invite(row, body)
    assert resp.status == "SUCCESS"
    row.share.assert_awaited_once_with()
    hub_call.assert_awaited_once_with("POST", "task", CONV_ID, "members", payload=body, strict=True)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_an_invite_link_is_minted_on_the_hub_after_publishing():
    row = _row("project", remote=False)
    resp, hub_call = await _invite(row, {"invitation_targets": []}, sub_path="link")
    assert resp.data == {"url": "https://hub.test/l/abc"}
    row.share.assert_awaited_once_with()
    hub_call.assert_awaited_once_with(
        "POST", "project", CONV_ID, "members", "link", payload={"invitation_targets": []}, strict=True
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.parametrize(
    ("action", "remote", "mode"),
    [(conversation_leave, True, "leave"), (conversation_owner_delete, True, "delete_for_all"),
     (conversation_owner_delete, False, "local")],
)
async def test_leave_and_delete_run_the_matching_removal(action, remote, mode):
    conv = Conversation.model_validate({"id": CONV_ID, "title": "t", "remote": remote})
    removal = AsyncMock(return_value="done")
    with (
        patch(f"{_FM}.get_current_request_info", return_value=_request({})),
        patch(f"{_FM}.handle_conversation_delete", new=removal),
    ):
        assert await action(conv) == "done"
    removal.assert_awaited_once_with(CONV_ID, mode, "user-x", allowed_conversation_ids=None)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_delete_asked_as_local_never_widens_to_everyone():
    """A row whose ``remote`` says hub, deleted with ``mode: "local"``: only this box's copy goes."""
    conv = Conversation.model_validate({"id": CONV_ID, "title": "t", "remote": True})
    removal = AsyncMock(return_value="done")
    with (
        patch(f"{_FM}.get_current_request_info", return_value=_request({"mode": "local"})),
        patch(f"{_FM}.handle_conversation_delete", new=removal),
    ):
        assert await conversation_owner_delete(conv) == "done"
    removal.assert_awaited_once_with(CONV_ID, "local", "user-x", allowed_conversation_ids=None)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_an_unknown_delete_mode_is_refused():
    conv = Conversation.model_validate({"id": CONV_ID, "title": "t", "remote": True})
    removal = AsyncMock()
    with (
        patch(f"{_FM}.get_current_request_info", return_value=_request({"mode": "everyone"})),
        patch(f"{_FM}.handle_conversation_delete", new=removal),
    ):
        resp = await conversation_owner_delete(conv)
    assert resp.status_code == 400
    removal.assert_not_awaited()
