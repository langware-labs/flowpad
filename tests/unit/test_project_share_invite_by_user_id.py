"""``Project.share`` can invite a contact known only by hub id.

Regression: a contact learned from a conversation roster (or the address
book) carries a ``user_id`` and NO email — the hub never discloses another
member's email to a non-admin. ``Project.share`` used to accept only
``recipients`` (emails), so such a contact could never be invited to a
project, silently, no matter what the UI staged. Mirrors
``Conversation.share``'s existing ``recipient_user_ids`` path exactly: same
``POST /graph/project/<id>/members``, ``recipient_user_id`` instead of
``recipient_email``.

Only the single network hop (``FlowpadClient.request``) is stubbed, same as
``test_project_share_idempotent.py``.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.app.actions.share_action import ShareInvitee
from flow_sdk.builtin.project import Project

GADI = "090ffc4d-af90-4d74-9514-aa8650abca7a"
NOA = "11111111-2222-4333-8444-555555555555"


class _FakeResponse:
    def __init__(self, status_code: int, text: str):
        self.status_code = status_code
        self.text = text

    def json(self):
        import json

        return json.loads(self.text)


_OK = '{"status":"success","data":{}}'


def _roster_response(rows: list[dict]) -> str:
    import json

    return json.dumps({"status": "success", "data": rows})


class _Calls(list):
    """A plain list that also carries the mutable roster state — lets a test
    set ``hub.state["roster"]`` before calling ``share()`` while every
    existing ``for ... in hub`` / ``hub == []`` usage still works."""

    state: dict


@pytest.fixture()
def hub(monkeypatch):
    """Record every hub call with its JSON body. The roster GET answers with
    ``hub.state["roster"]`` (empty by default), settable per test before
    ``share()``."""
    calls = _Calls()
    state = {"roster": []}
    calls.state = state

    async def fake_request(self, method, path, **kwargs):
        calls.append((method, path, kwargs.get("json")))
        if method == "GET":
            return _FakeResponse(200, _roster_response(state["roster"]))
        return _FakeResponse(200, _OK)

    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda: SimpleNamespace(api_key="test-key", user={"id": "alice"}),
    )
    monkeypatch.setattr("flow_sdk.cloud_client.client.ApiConfig.from_env", staticmethod(lambda: None))
    monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient.request", fake_request)
    return calls


def _invited_by_id(calls, proj: Project) -> dict[str, str]:
    """``{recipient_user_id: role}`` for every invite POST this share() made."""
    return {
        body["recipient_user_id"]: target["role"]
        for method, path, body in calls
        if method == "POST" and path == f"/graph/project/{proj.id}/members" and "recipient_user_id" in body
        for target in body["invitation_targets"]
    }


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_invite_by_user_id_defaults_to_member(hub):
    proj = Project(name="invite-by-id-default")

    await proj.share(invitees=[ShareInvitee(user_id=GADI)])

    assert _invited_by_id(hub, proj) == {GADI: "member"}


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_invite_by_user_id_honors_its_own_role(hub):
    proj = Project(name="invite-by-id-role")

    await proj.share(invitees=[ShareInvitee(user_id=GADI, role="admin")])

    assert _invited_by_id(hub, proj) == {GADI: "admin"}


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_invite_by_user_id_parses_the_user_typeid_form(hub):
    """The address book and the members roster hand out a bare id or a
    ``"user-<uuid>"`` typeid string — both mean the same person."""
    proj = Project(name="invite-by-id-typeid")

    await proj.share(invitees=[ShareInvitee(user_id=f"user-{GADI}")])

    assert _invited_by_id(hub, proj) == {GADI: "member"}


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_invite_by_user_id_and_by_email_each_keep_their_own_role(hub):
    """One call, one email recipient and one id-only recipient, each with
    their own role — the two addressing forms don't interfere."""
    proj = Project(name="invite-mixed")

    await proj.share(
        invitees=[
            ShareInvitee(email="noa@langware.ai", role="admin"),
            ShareInvitee(user_id=GADI, role="member"),
        ]
    )

    assert _invited_by_id(hub, proj) == {GADI: "member"}
    email_posts = [
        target["role"]
        for method, path, body in hub
        if method == "POST" and path == f"/graph/project/{proj.id}/members" and "recipient_email" in body
        for target in body["invitation_targets"]
    ]
    assert email_posts == ["admin"]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_invite_skips_a_user_id_already_on_the_roster(hub):
    """Re-sharing must not re-invite someone who already holds a role — the
    hub 400s that as "use change_role", failing the whole share."""
    hub.state["roster"] = [{"user_id": GADI, "role": "member", "status": "approved"}]
    proj = Project(name="invite-by-id-existing-member")

    await proj.share(invitees=[ShareInvitee(user_id=GADI), ShareInvitee(user_id=NOA)])

    assert _invited_by_id(hub, proj) == {NOA: "member"}


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_invite_silently_skips_an_unparseable_id(hub):
    """Mirrors ``Conversation.share``: junk in the list is dropped, not
    raised — the id must be a real UUID or the hub's point-read 404s."""
    proj = Project(name="invite-by-id-junk")

    await proj.share(invitees=[ShareInvitee(user_id="not-a-uuid"), ShareInvitee(user_id=GADI)])

    assert _invited_by_id(hub, proj) == {GADI: "member"}


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
@pytest.mark.parametrize("role", ["owner", "editor", ""])
async def test_invite_by_user_id_rejects_a_role_outside_the_allowlist(hub, role):
    """Refused before any hub call — nothing is published or invited."""
    proj = Project(name="invite-by-id-bad-role")

    with pytest.raises(ValueError, match="invite role"):
        await proj.share(invitees=[ShareInvitee(user_id=GADI, role=role)])

    assert hub == []


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_share_with_only_user_id_invitees_invites_them(hub):
    proj = Project(name="invite-by-id-only")

    await proj.share(invitees=[ShareInvitee(user_id=GADI)])

    member_posts = [
        (method, path)
        for method, path, _ in hub
        if method == "POST" and path == f"/graph/project/{proj.id}/members"
    ]
    assert len(member_posts) == 1
