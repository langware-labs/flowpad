"""Unit tests for the generic hub-reflect dispatcher.

The dispatcher lives in ``flow_sdk/server/routes/_hub_reflect.py``. It decides
when an action call should be forwarded to the hub instead of running locally,
and how the hub response is mirrored back into the local entity row.

These tests exercise the dispatcher helpers directly without spinning up the
full graph router — the integration path is covered by the hub e2e suite.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.actions.action_registry import Action
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.utils.hub import HubError


def _make_action(reflect=None, methods=("get",)):
    return Action(
        action_name="members",
        function_name="list_members",
        handler=lambda self: [],
        methods=list(methods),
        types=["all"],
        reflect=reflect,
    )


def _make_entity(*, remote: bool, participants=None):
    return Conversation(
        id=f"conv-test-{uuid.uuid4().hex[:8]}",
        title="t",
        remote=remote,
        participants=participants or [],
    )


@pytest.fixture()
def logged_in(monkeypatch):
    """Force ``is_logged_in()`` to True for the duration of the test."""
    import flow_sdk.server.routes._hub_reflect as mod

    monkeypatch.setattr(mod, "is_logged_in", lambda: True)
    return True


@pytest.fixture()
def logged_out(monkeypatch):
    import flow_sdk.server.routes._hub_reflect as mod

    monkeypatch.setattr(mod, "is_logged_in", lambda: False)
    return False


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_should_reflect_true_when_all_gates_pass(logged_in):
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    a = _make_action(reflect="hub")
    e = _make_entity(remote=True)
    assert should_reflect_to_hub(a, e) is True


@pytest.mark.timeout(30)
def test_should_reflect_false_when_no_reflect_marker(logged_in):
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    a = _make_action(reflect=None)
    e = _make_entity(remote=True)
    assert should_reflect_to_hub(a, e) is False


@pytest.mark.timeout(30)
def test_should_reflect_false_when_not_remote(logged_in):
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    a = _make_action(reflect="hub")
    e = _make_entity(remote=False)
    assert should_reflect_to_hub(a, e) is False


@pytest.mark.timeout(30)
def test_should_reflect_false_when_entity_none(logged_in):
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    a = _make_action(reflect="hub")
    assert should_reflect_to_hub(a, None) is False


@pytest.mark.timeout(30)
def test_should_reflect_false_when_logged_out(logged_out):
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    a = _make_action(reflect="hub")
    e = _make_entity(remote=True)
    assert should_reflect_to_hub(a, e) is False


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_reflect_to_hub_forwards_get_and_mirrors_participants(monkeypatch):
    """GET action: hub_get is called with the right path; response replaces local participants."""
    import flow_sdk.server.routes._hub_reflect as mod

    captured = {}
    # Hub-native shape — ``user_email`` / ``user_name`` get normalized by the
    # dispatcher to ``email`` / ``name`` before returning to caller and
    # mirroring onto the local row.
    hub_payload = [
        {"user_id": "u-alice", "user_email": "alice@example.com", "user_name": "Alice", "role": "owner", "status": "approved"},
        {"user_id": "u-bob", "user_email": "bob@example.com", "user_name": "Bob", "role": "member", "status": "approved"},
    ]
    expected_normalized = [
        {"user_id": "u-alice", "role": "owner", "status": "approved", "email": "alice@example.com", "name": "Alice"},
        {"user_id": "u-bob", "role": "member", "status": "approved", "email": "bob@example.com", "name": "Bob"},
    ]

    async def fake_hub_get(entity_type, entity_id=None, action=None, **kwargs):
        captured["et"] = entity_type
        captured["id"] = entity_id
        captured["action"] = action
        return hub_payload

    async def fake_save(self_=None, **kwargs):
        captured["saved"] = True
        return None

    monkeypatch.setattr(mod, "hub_get", fake_hub_get)
    monkeypatch.setattr(Conversation, "save", fake_save)

    a = _make_action(reflect="hub", methods=("get",))
    e = _make_entity(remote=True, participants=[{"user_id": "stale"}])

    result = await mod.reflect_to_hub(a, e, {})

    assert result == expected_normalized
    assert captured["id"] == e.id
    assert captured["action"] == "members"
    assert captured["et"].value == "conversation"
    assert e.participants == expected_normalized  # local row mirrored to normalized shape
    assert captured.get("saved") is True


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_reflect_to_hub_raises_huberror_when_hub_get_returns_none(monkeypatch):
    """``hub_get`` returns None on transport/HTTP failure — dispatcher must
    surface this as HubError so the caller falls through to the local handler."""
    import flow_sdk.server.routes._hub_reflect as mod

    async def fake_hub_get(*args, **kwargs):
        return None

    monkeypatch.setattr(mod, "hub_get", fake_hub_get)

    a = _make_action(reflect="hub", methods=("get",))
    e = _make_entity(remote=True)

    with pytest.raises(HubError):
        await mod.reflect_to_hub(a, e, {})


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_reflect_to_hub_uses_post_for_mutating_actions(monkeypatch):
    import flow_sdk.server.routes._hub_reflect as mod

    captured = {}

    async def fake_hub_post(entity_type, payload, entity_id=None, action=None, **kwargs):
        captured["payload"] = payload
        captured["action"] = action
        return {"ok": True}

    monkeypatch.setattr(mod, "hub_post", fake_hub_post)

    a = _make_action(reflect="hub", methods=("post",))
    a.action_name = "rename"  # arbitrary mutating action
    e = _make_entity(remote=True)

    result = await mod.reflect_to_hub(a, e, {"new_name": "x"})

    assert result == {"ok": True}
    assert captured["payload"] == {"new_name": "x"}
    assert captured["action"] == "rename"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_reflect_to_hub_forwards_delete_body_and_refreshes_roster(monkeypatch):
    """DELETE members: the member-selector body must be forwarded to
    ``hub_delete`` verbatim (this is the link that was silently dropping the
    selector → empty ``{}`` → hub 500), and the post-remove roster re-fetched
    via ``hub_get`` and mirrored onto the local row."""
    import flow_sdk.server.routes._hub_reflect as mod

    captured = {}

    async def fake_hub_delete(entity_type, entity_id=None, action=None, *, payload=None, **kwargs):
        captured["payload"] = payload
        captured["action"] = action
        captured["et"] = entity_type
        captured["id"] = entity_id
        return {"message": "removed"}

    async def fake_hub_get(entity_type, entity_id=None, action=None, **kwargs):
        # Canonical roster after the removal — bob is gone.
        return [{"user_id": "u-alice", "role": "owner", "status": "approved"}]

    async def fake_save(self_=None, **kwargs):
        captured["saved"] = True
        return None

    monkeypatch.setattr(mod, "hub_delete", fake_hub_delete)
    monkeypatch.setattr(mod, "hub_get", fake_hub_get)
    monkeypatch.setattr(Conversation, "save", fake_save)

    a = _make_action(reflect="hub", methods=("delete",))
    e = _make_entity(remote=True, participants=[{"user_id": "u-bob"}])

    result = await mod.reflect_to_hub(a, e, {"user_id": "u-bob"})

    # Body forwarded verbatim — the new identifier shape, no member_through envelope.
    assert captured["payload"] == {"user_id": "u-bob"}
    assert captured["action"] == "members"
    assert captured["et"].value == "conversation"
    assert captured["id"] == e.id
    # Roster re-fetched after the remove and mirrored onto the local row.
    assert result == [{"user_id": "u-alice", "role": "owner", "status": "approved"}]
    assert e.participants == [{"user_id": "u-alice", "role": "owner", "status": "approved"}]
    assert captured.get("saved") is True


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_reflect_to_hub_skips_unknown_entity_type(monkeypatch):
    """Entities whose ``type`` isn't a builtin enum value have no hub
    representation — reflection must raise HubError so the caller falls
    through to local."""
    import flow_sdk.server.routes._hub_reflect as mod

    a = _make_action(reflect="hub", methods=("get",))
    e = _make_entity(remote=True)
    e.type = "some-plugin-defined-type"  # not in BuiltinEntityType

    with pytest.raises(HubError):
        await mod.reflect_to_hub(a, e, {})


@pytest.mark.timeout(30)
def test_normalize_preserves_hub_only_fields():
    """invitation_id, invitation_method, picture, and any future hub-added key
    must pass through the normalizer unchanged so downstream callers (pending-
    invite UX, role-management UI) don't lose data at the dispatcher boundary."""
    from flow_sdk.server.routes._hub_reflect import _normalize_hub_response

    hub_resp = [
        {
            "user_id": "u-1",
            "user_email": "alice@example.com",
            "user_name": "Alice",
            "user_picture": "https://cdn/alice.png",
            "role": "owner",
            "status": "approved",
            "invitation_id": "inv-123",
            "invitation_method": "email",
            "joined_at": "2026-05-27T10:00:00Z",  # hypothetical future field
        }
    ]
    out = _normalize_hub_response("members", hub_resp)
    assert len(out) == 1
    e = out[0]
    # Hub legacy keys translated to client form.
    assert e["email"] == "alice@example.com"
    assert e["name"] == "Alice"
    assert e["picture"] == "https://cdn/alice.png"
    # Pass-through keys preserved.
    assert e["invitation_id"] == "inv-123"
    assert e["invitation_method"] == "email"
    assert e["joined_at"] == "2026-05-27T10:00:00Z"
    assert e["role"] == "owner"
    assert e["status"] == "approved"
    # Legacy keys removed (replaced by client form).
    assert "user_email" not in e
    assert "user_name" not in e
    assert "user_picture" not in e


@pytest.mark.timeout(30)
def test_normalize_client_key_wins_over_hub_legacy():
    """If a (future) hub emits both ``email`` and ``user_email`` during a
    migration, the client-form key wins so the renamed contract stays
    authoritative."""
    from flow_sdk.server.routes._hub_reflect import _normalize_hub_response

    out = _normalize_hub_response(
        "members",
        [{"email": "client@example.com", "user_email": "legacy@example.com"}],
    )
    assert out[0]["email"] == "client@example.com"
    assert "user_email" not in out[0]


@pytest.mark.timeout(30)
def test_normalize_passes_through_non_list_and_non_members():
    """Empty dict (hub returns no data), non-members actions, and non-dict
    entries must round-trip unchanged."""
    from flow_sdk.server.routes._hub_reflect import _normalize_hub_response

    # Non-members action: untouched.
    assert _normalize_hub_response("rename", {"title": "x"}) == {"title": "x"}
    # Members action but non-list (hub returned {} via the empty-list coercion
    # in hub.py:191 — caller will handle this defensively).
    assert _normalize_hub_response("members", {}) == {}
    # Members action with a non-dict entry (defensive: don't crash).
    out = _normalize_hub_response("members", [{"user_email": "a@x.com"}, "weird"])
    assert out[0]["email"] == "a@x.com"
    assert out[1] == "weird"


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_mirror_skips_when_entity_has_no_participants_field(monkeypatch):
    """``mirror_hub_response_into_local`` is opportunistic — entities without
    a participants field must not raise."""
    from flow_sdk.builtin.user import User
    from flow_sdk.server.routes._hub_reflect import mirror_hub_response_into_local

    u = User(id="u-1")  # has no ``participants`` field
    # Should be a no-op, no exception raised.
    await mirror_hub_response_into_local(u, "members", [{"user_id": "x"}])
