"""Verify ``handle_invitation_accept`` distinguishes the two 302 shapes.

The hub returns 302 from ``GET /members/accept`` in TWO unrelated cases:

  * Location ``/login.html?target_path=...`` — request was unauthenticated;
    accept did NOT execute server-side. We must NOT run local cleanup or
    we'd write ``accepted=True`` locally for an invitation the hub never
    accepted, causing every downstream conversation-scoped call to fail
    with 401 ("no valid access for role ['member']").

  * Location ``/flow_message/<id>`` or ``/conversation/<id>`` — post-accept
    landing redirect; accept succeeded and the hub is telling us which
    entity got granted. Run local cleanup (mark accepted, join, sync).

Verified against app.flowpad.ai on 2026-05-28: bogus invitation-id with
no auth → 302 to /login.html; real invitation-id with valid auth → 302
to /flow_message/<id>.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest


@pytest.mark.asyncio
async def test_handle_invitation_accept_302_to_login_fails_and_skips_cleanup(monkeypatch):
    """302 with Location pointing at /login.html → ApiFailResponse, no cleanup."""
    from flow_sdk.app.actions import flow_message_action
    from flow_sdk.responses.response import ApiFailResponse

    monkeypatch.setattr(flow_message_action, "hub_base_url", lambda: "https://hub.test", raising=False)
    monkeypatch.setattr(
        flow_message_action,
        "hub_get",
        AsyncMock(side_effect=AssertionError("hub_get must not be called on a login redirect")),
        raising=False,
    )

    location = (
        "https://hub.test/login.html?target_path="
        "https%3A%2F%2Fhub.test%2Fapi%2Fv1%2Fgraph%2Fmembers%2Faccept"
    )
    mock_resp = MagicMock(spec=httpx.Response)
    mock_resp.status_code = 302
    mock_resp.headers = {"location": location}
    mock_resp.text = ""

    mock_client = MagicMock()
    mock_client.request = AsyncMock(return_value=mock_resp)
    mock_client.post = AsyncMock(side_effect=AssertionError("hub.post must not be called on a login redirect"))
    mock_client.get = AsyncMock(side_effect=AssertionError("hub.get must not be called on a login redirect"))
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("flow_sdk.cloud_client.FlowpadClient", return_value=mock_client):
        result = await flow_message_action.handle_invitation_accept(
            {"invitation_id": "deadbeef-dead-beef-dead-beefdeadbeef"},
            someone_typeid="user-1",
        )

    assert isinstance(result, ApiFailResponse)
    assert "login" in result.message.lower()
    assert "login.html" in result.message
    mock_client.post.assert_not_called()
    mock_client.get.assert_not_called()


@pytest.mark.asyncio
async def test_handle_invitation_accept_302_to_flow_message_runs_cleanup(monkeypatch):
    """302 with Location pointing at /flow_message/<id> → post-accept landing.

    The accept succeeded server-side; the FM id is in the path. We must
    parse it out and proceed with local cleanup (here we only assert the
    FM id was extracted from Location, not the full cleanup chain).
    """
    from flow_sdk.app.actions import flow_message_action

    monkeypatch.setattr(flow_message_action, "hub_base_url", lambda: "https://hub.test", raising=False)

    # Capture what hub_get is called with — confirms Location parsing yielded
    # the right FM id and that the cleanup path proceeded past the rejection.
    fm_lookups = []

    async def fake_hub_get(entity_type, entity_id, *args, **kwargs):
        fm_lookups.append((entity_type, entity_id))
        return {}  # Empty dict; further cleanup will no-op.

    monkeypatch.setattr(flow_message_action, "hub_get", fake_hub_get, raising=False)

    fm_id = "c48e18bf-617c-4da9-a5a0-7c517c17fd50"
    mock_resp = MagicMock(spec=httpx.Response)
    mock_resp.status_code = 302
    mock_resp.headers = {"location": f"https://hub.test/flow_message/{fm_id}"}
    mock_resp.text = ""

    mock_client = MagicMock()
    mock_client.request = AsyncMock(return_value=mock_resp)
    mock_client.post = AsyncMock(return_value={})
    mock_client.get = AsyncMock(return_value={})
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("flow_sdk.cloud_client.FlowpadClient", return_value=mock_client):
        result = await flow_message_action.handle_invitation_accept(
            {"invitation_id": "deadbeef-dead-beef-dead-beefdeadbeef"},
            someone_typeid="user-1",
        )

    # The Location parser fed the FM id into hub_get to resolve the parent conv.
    assert fm_lookups and fm_lookups[0][1] == fm_id
    # Action returned the resolved typeids in its success payload.
    assert getattr(result, "status", None) != "fail"
    assert result.data.get("flow_message_id") == fm_id


@pytest.mark.asyncio
async def test_learn_address_book_accepts_hub_member_keys(monkeypatch):
    """Hub rosters may use user_email/user_name; contacts use email/name. A
    participant with only a ``user_id`` (no email) is now ALSO learned — keyed by
    user_id — instead of being dropped."""
    from flow_sdk.app.actions import flow_message_action

    calls = []

    async def fake_upsert(*, user_id=None, email=None, name=None, picture=None, remote=False):
        calls.append((user_id, email, name))
        return object()  # non-None → counts as upserted

    monkeypatch.setattr(
        flow_message_action.User,
        "upsert_contact",
        fake_upsert,
    )

    upserted = await flow_message_action._learn_address_book([
        {"user_email": "alice@example.com", "user_name": "Alice"},
        {"email": "bob@example.com", "name": "Bob"},
        {"user_id": "no-email", "user_name": "No Email"},
    ])

    assert calls == [
        (None, "alice@example.com", "Alice"),
        (None, "bob@example.com", "Bob"),
        ("no-email", None, "No Email"),
    ]
    assert upserted == 3


@pytest.mark.asyncio
async def test_handle_invitation_accept_learns_conversation_participants(monkeypatch):
    """Accepting a conversation invitation learns every roster email as a contact."""
    import flow_sdk.utils.hub as hub_utils
    from flow_sdk.app.actions import flow_message_action
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.invitation import Invitation

    monkeypatch.setattr(hub_utils, "hub_base_url", lambda: "https://hub.test")
    monkeypatch.setattr(flow_message_action, "hub_base_url", lambda: "https://hub.test", raising=False)

    conv_id = "11111111-1111-4111-8111-111111111111"
    embedded_participants = [
        {"user_id": "alice-id", "user_email": "alice@example.com", "user_name": "Alice"},
    ]
    authoritative_members = [
        {"user_id": "alice-id", "user_email": "alice@example.com", "user_name": "Alice"},
        {"user_id": "bob-id", "email": "bob@example.com", "name": "Bob"},
    ]

    accept_resp = MagicMock(spec=httpx.Response)
    accept_resp.status_code = 200
    accept_resp.headers = {}
    accept_resp.text = '{"data": "conversation-11111111-1111-4111-8111-111111111111"}'
    accept_resp.json.return_value = {"data": f"conversation-{conv_id}"}

    accept_client = MagicMock()
    accept_client.request = AsyncMock(return_value=accept_resp)
    accept_client.__aenter__ = AsyncMock(return_value=accept_client)
    accept_client.__aexit__ = AsyncMock(return_value=False)

    conversation_client = MagicMock()
    conversation_client.post = AsyncMock(return_value={})
    conversation_client.get = AsyncMock(side_effect=[
        {
            "id": conv_id,
            "title": "accepted",
            "participants": embedded_participants,
        },
        authoritative_members,
    ])
    conversation_client.__aenter__ = AsyncMock(return_value=conversation_client)
    conversation_client.__aexit__ = AsyncMock(return_value=False)

    learned = AsyncMock()
    monkeypatch.setattr(flow_message_action, "_learn_address_book", learned)
    monkeypatch.setattr(flow_message_action, "_upsert_hub_conversation_metadata", AsyncMock())
    monkeypatch.setattr(flow_message_action, "_sync_conversation_messages", AsyncMock())
    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda: MagicMock(api_key="test-key"),
    )

    async def fake_get_one(*args, **kwargs):
        return None

    monkeypatch.setattr(Invitation, "get_one", fake_get_one)
    monkeypatch.setattr(Conversation, "get_one", fake_get_one)

    with patch("flow_sdk.cloud_client.FlowpadClient", return_value=accept_client), \
            patch("flow_sdk.cloud_client.client.FlowpadClient", return_value=conversation_client):
        result = await flow_message_action.handle_invitation_accept(
            {"invitation_id": "deadbeef-dead-beef-dead-beefdeadbeef"},
            someone_typeid="user-1",
        )

    assert getattr(result, "status", None) != "fail"
    assert result.data.get("conversation_id") == conv_id
    learned.assert_any_await(authoritative_members)
    conversation_client.get.assert_any_await(f"/graph/conversation/{conv_id}/members")


@pytest.mark.asyncio
async def test_handle_invitation_accept_non_2xx_non_302_returns_failure(monkeypatch):
    """A 500 (or other non-success, non-302) still surfaces as ApiFailResponse."""
    from flow_sdk.app.actions import flow_message_action
    from flow_sdk.responses.response import ApiFailResponse

    monkeypatch.setattr(flow_message_action, "hub_base_url", lambda: "https://hub.test", raising=False)

    mock_resp = MagicMock(spec=httpx.Response)
    mock_resp.status_code = 500
    mock_resp.headers = {}
    mock_resp.text = '{"detail": "boom"}'

    mock_client = MagicMock()
    mock_client.request = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("flow_sdk.cloud_client.FlowpadClient", return_value=mock_client):
        result = await flow_message_action.handle_invitation_accept(
            {"invitation_id": "deadbeef-dead-beef-dead-beefdeadbeef"},
            someone_typeid="user-1",
        )

    assert isinstance(result, ApiFailResponse)
    assert "500" in result.message
    assert "login" not in result.message.lower()
