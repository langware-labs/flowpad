"""The invite conversation of a project share, on the generic share path.

A project invite's conversation is shared like any other (``Conversation.share``):
its invitation can skip the hub's email, because the project invite already
emails the person (``notify_by_email=False``), and a team is admitted as one
group principal (``principals``). The message that carries the project into it
must not re-parent the project under the conversation (a membership container
is a hub-owned root). ``discard_invite_conversation`` removes a conversation
whose invite failed.

Only the network hops are stubbed: ``FlowpadClient.request`` (create, join,
invite, delete) and ``HubProxy``.

# do not increase timeout without approval
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.project import Project
from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient
from flow_sdk.cloud_client.hub_proxy import HubProxy

SHARER = "0a0a0a0a-0000-4000-8000-000000000001"


class _FakeResponse:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self):
        return json.loads(self.text)


class _Hub(list):
    """Every hub hop as ``(method, path)`` in call order; ``bodies`` the JSON
    body of each."""

    bodies: list


@pytest.fixture()
def hub(monkeypatch):
    calls = _Hub()
    calls.bodies = []

    async def fake_request(self, method, path, **kwargs):
        calls.append((method, path))
        calls.bodies.append((path, kwargs.get("json")))
        return _FakeResponse(200, {"status": "success", "data": {}})

    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda *a, **k: SimpleNamespace(
            api_key="test-key", user={"id": SHARER, "email": "sharer@example.com"}, is_expired=lambda *_a: False
        ),
    )
    monkeypatch.setattr("flow_sdk.cloud_client.client.ApiConfig.from_env", staticmethod(lambda: None))
    monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient.request", fake_request)
    # The shared hub transport (``HubProxy.send``) answers from the same fake.

    async def fake_send(method, url, **kwargs):
        fake = await fake_request(None, method, str(url), **kwargs)
        return httpx.Response(fake.status_code, text=fake.text, request=httpx.Request(method, str(url)))

    monkeypatch.setattr(HubProxy, "send", staticmethod(fake_send))
    return calls


def _invitations(hub: _Hub) -> list[dict]:
    """The JSON body of every conversation-membership invitation, in order."""
    return [body for path, body in hub.bodies if path.rstrip("/").endswith("/members") and body]


async def _conversation() -> Conversation:
    conv = Conversation.model_validate({"title": 'Invite: "Course"', "status": "open"})
    conv.id = Conversation.allocate_id(conv.model_dump())
    return await conv.save()


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_an_invitation_can_skip_the_hubs_email(hub):
    conv = await _conversation()

    await conv.share(recipients=["invitee@example.com"], notify_by_email=False)

    (invitation,) = _invitations(hub)
    assert invitation["recipient_email"] == "invitee@example.com"
    assert invitation["notify_by_email"] is False


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_an_invitation_emails_by_default(hub):
    conv = await _conversation()

    await conv.share(recipients=["invitee@example.com"])

    (invitation,) = _invitations(hub)
    assert "notify_by_email" not in invitation


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_team_is_admitted_as_one_group_grant(hub):
    conv = await _conversation()

    await conv.share(principals=["team-7a7a7a7a-0000-4000-8000-00000000000b"])

    (invitation,) = _invitations(hub)
    assert invitation["principal"] == "team-7a7a7a7a-0000-4000-8000-00000000000b"
    assert invitation["invitation_targets"][0]["typeid"] == f"conversation-{conv.id}"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_project_in_the_conversation_is_never_reparented_under_it(hub):
    project = await Project(name=f"Course-{uuid4().hex[:8]}").save()
    conv = await _conversation()

    await conv._link_context_to_conversation([str(project.typeid)])

    assert (await Project.get_one({"id": project.id})).parent_type_id in (None, "")


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_discard_deletes_on_the_hub_and_locally(hub):
    conv = await _conversation()
    await conv.share(recipients=["invitee@example.com"])
    async with FlowpadClient(ApiConfig.from_env(), api_key="test-key") as client:
        await conv.discard_invite_conversation(client)

    assert hub[-1][0] == "DELETE"
    assert await Conversation.get_one({"id": conv.id}) is None

@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_conversation_default_and_explicit_role_sets(hub):
    conv = await _conversation()
    await conv.share(recipients=["default@example.com"])
    assert _invitations(hub)[-1]["invitation_targets"][0]["roles"] == ["reader", "runner"]
    await conv.share(recipients=["run@example.com"], invitation={
        "invitation_targets": [{"typeid": str(conv.typeid), "roles": ["runner"]}]
    })
    assert _invitations(hub)[-1]["invitation_targets"][0] == {"typeid": str(conv.typeid), "roles": ["runner"]}
