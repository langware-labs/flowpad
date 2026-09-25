"""``Project.share`` grants a role per recipient, not one role for the batch.

Each ``ShareInvitee`` carries its own role directly alongside its identifier —
no separate role map to look up. A recipient with no role, or ``invitees``
itself omitted, gets ``PROJECT_DEFAULT_INVITE_ROLE`` (``member``). Any value
outside ``PROJECT_INVITE_ROLES`` is rejected before touching the hub.

Only the single network hop (``FlowpadClient.request``) is stubbed, same as
``test_project_share_idempotent.py``.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.app.actions.share_action import ShareInvitee
from flow_sdk.builtin.project import Project


class _FakeResponse:
    def __init__(self, status_code: int, text: str):
        self.status_code = status_code
        self.text = text

    def json(self):
        import json

        return json.loads(self.text)


_OK = '{"status":"success","data":{}}'
_EMPTY_ROSTER = '{"status":"success","data":[]}'


@pytest.fixture()
def hub(monkeypatch):
    """Record every hub call with its JSON body."""
    calls: list[tuple[str, str, object]] = []

    async def fake_request(self, method, path, **kwargs):
        calls.append((method, path, kwargs.get("json")))
        return _FakeResponse(200, _EMPTY_ROSTER if method == "GET" else _OK)

    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda: SimpleNamespace(api_key="test-key", user={"id": "alice"}),
    )
    monkeypatch.setattr("flow_sdk.cloud_client.client.ApiConfig.from_env", staticmethod(lambda: None))
    monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient.request", fake_request)
    return calls


def _invited_roles(calls, proj: Project) -> dict[str, str]:
    """``{recipient_email: role}`` for every invite POST this share() made."""
    return {
        body["recipient_email"]: target["role"]
        for method, path, body in calls
        if method == "POST" and path == f"/graph/project/{proj.id}/members"
        for target in body["invitation_targets"]
    }


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_invite_defaults_to_member_with_no_role(hub):
    proj = Project(name="invite-role-default")

    await proj.share(invitees=[ShareInvitee(email="noa@langware.ai")])

    assert _invited_roles(hub, proj) == {"noa@langware.ai": "member"}


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_invite_grants_a_different_role_per_recipient(hub):
    """THE POINT: one call, two people, two different roles."""
    proj = Project(name="invite-role-per-recipient")

    await proj.share(
        invitees=[
            ShareInvitee(email="noa@langware.ai", role="admin"),
            ShareInvitee(email="gadi@langware.ai"),
        ]
    )

    assert _invited_roles(hub, proj) == {
        "noa@langware.ai": "admin",
        "gadi@langware.ai": "member",  # no role on the invitee -> the default
    }


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
@pytest.mark.parametrize("role", ["owner", "editor", "", "Admin"])
async def test_invite_rejects_a_role_outside_the_allowlist(hub, role):
    """Refused before any hub call — nothing is published or invited."""
    proj = Project(name="invite-role-bad")

    with pytest.raises(ValueError, match="invite role"):
        await proj.share(invitees=[ShareInvitee(email="noa@langware.ai", role=role)])

    assert hub == []
