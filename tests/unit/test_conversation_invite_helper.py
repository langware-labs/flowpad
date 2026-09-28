"""The sharer-built invite conversation of a project share.

``Conversation.open_invite_conversation`` creates a ROOT-level hub conversation
and joins it; the caller grants the recipient; ``post_invite_message`` then sends
the one message — header first, then the body bundle, because the hub stamps a
client-sent TYPE_ID message ``uploading`` and receivers wait for READY.
``discard_invite_conversation`` removes it when the grant fails.

Only the network hops are stubbed: ``FlowpadClient.request`` (create, join,
add_message header, delete) and ``flow_sdk.utils.hub.hub_post`` (body upload and
the READY flip), recorded in ONE list so the order is observable.

# do not increase timeout without approval
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import AttachmentType, BodyStatus, FlowMessage
from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient

SHARER = "0a0a0a0a-0000-4000-8000-000000000001"
PROJECT = "project-9e9e9e9e-0000-4000-8000-00000000000a"


class _FakeResponse:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self):
        return json.loads(self.text)


class _Hub(list):
    """Every hub hop as ``(method, path)`` in call order; ``refuse`` maps a
    path suffix to the status that hop answers with."""

    refuse: dict


@pytest.fixture()
def hub(monkeypatch):
    calls = _Hub()
    calls.refuse = {}

    async def fake_request(self, method, path, **kwargs):
        calls.append((method, path))
        for suffix, status in calls.refuse.items():
            if path.endswith(suffix):
                return _FakeResponse(status, {"detail": "refused"})
        return _FakeResponse(200, {"status": "success", "data": {}})

    async def fake_hub_post(entity_type, data, *path_parts, action=None, **_kwargs):
        suffix = action or "/".join(str(p) for p in path_parts[1:])
        calls.append(("HUB_POST", suffix))
        if suffix in calls.refuse:
            raise RuntimeError(f"hub refused {suffix}")
        return {}

    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda *a, **k: SimpleNamespace(api_key="test-key", user={"id": SHARER, "email": "sharer@example.com"}),
    )
    monkeypatch.setattr("flow_sdk.cloud_client.client.ApiConfig.from_env", staticmethod(lambda: None))
    monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient.request", fake_request)
    monkeypatch.setattr("flow_sdk.utils.hub.hub_post", fake_hub_post)
    return calls


def _hops(hub: _Hub) -> list[str]:
    """Readable call order: the last meaningful path segment of each hop."""
    out = []
    for method, path in hub:
        if method == "HUB_POST":
            out.append(path)
        elif path.rstrip("/").endswith("/join"):
            out.append("join")
        elif path.rstrip("/").endswith("/add_message"):
            out.append("add_message")
        elif method == "POST" and path.rstrip("/").endswith("/conversation"):
            out.append("create")
        elif method == "DELETE":
            out.append("delete")
    return out


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_open_then_post_runs_create_join_header_then_body(hub):
    async with FlowpadClient(ApiConfig.from_env(), api_key="test-key") as client:
        conv = await Conversation.open_invite_conversation('Invite: "Course"', client)
        fm = await conv.post_invite_message('I invited you to project "Course".', PROJECT)

    assert _hops(hub) == ["create", "join", "add_message", "fs/upload", "set_body_status"]
    create = next(path for method, path in hub if method == "POST" and path.rstrip("/").endswith("/conversation"))
    assert create.rstrip("/").endswith("/graph/conversation"), f"not a root-level create: {create}"
    assert conv.remote is True

    local = await FlowMessage.get_one({"id": fm.id})
    assert local.remote is True
    assert local.body_status == BodyStatus.READY
    references = [a.data for a in local.attachment if a.attachment_type == AttachmentType.TYPE_ID]
    assert PROJECT in references
    assert local.text == 'I invited you to project "Course".'


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_refused_header_surfaces_and_uploads_nothing(hub):
    hub.refuse["/add_message"] = 500
    async with FlowpadClient(ApiConfig.from_env(), api_key="test-key") as client:
        conv = await Conversation.open_invite_conversation("Invite", client)
        with pytest.raises(RuntimeError, match="did not accept the invite message"):
            await conv.post_invite_message("I invited you.", PROJECT)

    assert "fs/upload" not in _hops(hub)


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_failed_body_upload_surfaces_to_the_caller(hub):
    hub.refuse["fs/upload"] = 500
    async with FlowpadClient(ApiConfig.from_env(), api_key="test-key") as client:
        conv = await Conversation.open_invite_conversation("Invite", client)
        with pytest.raises(RuntimeError, match="fs/upload"):
            await conv.post_invite_message("I invited you.", PROJECT)

    assert "set_body_status" not in _hops(hub)


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_discard_deletes_on_the_hub_and_locally(hub):
    async with FlowpadClient(ApiConfig.from_env(), api_key="test-key") as client:
        conv = await Conversation.open_invite_conversation("Invite", client)
        await conv.discard_invite_conversation(client)

    assert _hops(hub)[-1] == "delete"
    assert await Conversation.get_one({"id": conv.id}) is None
