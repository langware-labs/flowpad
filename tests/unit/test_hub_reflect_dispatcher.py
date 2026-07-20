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


def _make_action(methods=("get",)):
    return Action(
        action_name="members",
        function_name="list_members",
        handler=lambda self: [],
        methods=list(methods),
        types=["all"],
    )


def _make_entity(*, remote: bool, members=None):
    return Conversation(
        id=f"conv-test-{uuid.uuid4().hex[:8]}",
        title="t",
        remote=remote,
        members=members or [],
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
    """hub_reflect requested + remote entity + logged in → reflect."""
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    e = _make_entity(remote=True)
    assert should_reflect_to_hub(e, hub_reflect=True) is True


@pytest.mark.timeout(30)
def test_should_reflect_false_when_hub_reflect_not_requested(logged_in):
    """Default is DON'T reflect: a remote entity does NOT reflect unless the call
    explicitly opts in (the action no longer carries a reflect marker)."""
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    e = _make_entity(remote=True)
    assert should_reflect_to_hub(e, hub_reflect=False) is False


@pytest.mark.timeout(30)
def test_should_reflect_false_when_not_remote(logged_in):
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    e = _make_entity(remote=False)
    assert should_reflect_to_hub(e, hub_reflect=True) is False


@pytest.mark.timeout(30)
def test_should_reflect_false_when_entity_none(logged_in):
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    assert should_reflect_to_hub(None, hub_reflect=True) is False


@pytest.mark.timeout(30)
def test_should_reflect_false_when_logged_out(logged_out):
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    e = _make_entity(remote=True)
    assert should_reflect_to_hub(e, hub_reflect=True) is False


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_reflect_to_hub_forwards_get_and_mirrors_members(monkeypatch):
    """GET action: hub_get is called with the right path; response replaces local members."""
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

    a = _make_action(methods=("get",))
    e = _make_entity(remote=True, members=[{"user_id": "stale"}])

    result = await mod.reflect_to_hub(a, e, {}, "get")

    assert result == expected_normalized
    assert captured["id"] == e.id
    assert captured["action"] == "members"
    assert captured["et"].value == "conversation"
    assert e.members == expected_normalized  # local row mirrored to normalized shape
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

    a = _make_action(methods=("get",))
    e = _make_entity(remote=True)

    with pytest.raises(HubError):
        await mod.reflect_to_hub(a, e, {}, "get")


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_reflect_uses_request_method_not_action_methods(monkeypatch):
    """REGRESSION LOCK for the "Cloud request rejected" inbox bug.

    ``members`` registers a GET (list) and a DELETE (remove) handler under one
    registry key; the DELETE ``Action`` overwrites the GET, so ``get_by_name``
    returns the DELETE-registered ``Action`` for a roster **GET**. Reflection must
    take the verb from the REAL request method, never from ``a.methods`` — otherwise
    a roster GET reflects as a hub DELETE with an empty body → hub 400 → toast.

    Here the matched Action declares ``methods=["delete"]`` (simulating the
    overwrite) but the incoming request method is GET: reflect MUST call hub_get
    and MUST NOT call hub_delete.
    """
    import flow_sdk.server.routes._hub_reflect as mod

    calls = {"get": 0, "delete": 0}

    async def fake_hub_get(entity_type, entity_id=None, action=None, **kwargs):
        calls["get"] += 1
        return [{"user_id": "u-alice", "role": "owner"}]

    async def fake_hub_delete(*args, **kwargs):
        calls["delete"] += 1
        return {"message": "should-not-happen"}

    async def fake_save(self_=None, **kwargs):
        return None

    monkeypatch.setattr(mod, "hub_get", fake_hub_get)
    monkeypatch.setattr(mod, "hub_delete", fake_hub_delete)
    monkeypatch.setattr(Conversation, "save", fake_save)

    # Action resolved by name-only lookup is the DELETE handler (the bug's setup).
    a = _make_action(methods=("delete",))
    e = _make_entity(remote=True, members=[{"user_id": "stale"}])

    # ...but the actual request is a roster GET.
    result = await mod.reflect_to_hub(a, e, {}, "get")

    assert calls["get"] == 1, "roster GET must reflect as a hub GET"
    assert calls["delete"] == 0, "a GET must never reflect as a destructive hub DELETE"
    assert result == [{"user_id": "u-alice", "role": "owner"}]


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

    a = _make_action(methods=("post",))
    a.action_name = "rename"  # arbitrary mutating action
    e = _make_entity(remote=True)

    result = await mod.reflect_to_hub(a, e, {"new_name": "x"}, "post")

    assert result == {"ok": True}
    assert captured["payload"] == {"new_name": "x"}
    assert captured["action"] == "rename"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_reflect_to_hub_put_merges_hub_response_and_returns_merged(monkeypatch):
    """A PUT/PATCH (the generic ``update`` action — e.g. a conversation rename)
    reflects as a bare hub PUT to ``/<type>/<id>`` via ``hub_put`` (NOT a POST to
    ``/<type>/<id>/update``), then MERGES the hub's authoritative response onto the
    local row and returns the MERGED LOCAL entity:
      - scalar fields (title, server times) the hub changed are applied locally,
      - a saved+notify broadcast fans the update to local watchers,
      - LIST fields (``members``) are NOT clobbered — they keep their local
        normalized shape (their own sync path owns them),
      - the return value is the merged local entity (``model_dump``), not the raw
        hub response."""
    import flow_sdk.server.routes._hub_reflect as mod

    captured = {}

    async def fake_hub_put(entity_type, entity_id, payload, **kwargs):
        captured["et"] = entity_type
        captured["id"] = entity_id
        captured["payload"] = payload
        # Hub echoes the entity with the new title + a server-set timestamp, plus a
        # hub-shaped members list that must NOT overwrite the local one.
        return {
            "id": entity_id,
            "title": payload.get("title"),
            "created_date": "2026-06-02T10:00:00Z",
            "members": [{"user_id": "u-hub", "name": "HubShape"}],
        }

    async def boom(*args, **kwargs):  # must NOT be called
        raise AssertionError("PUT must reflect via hub_put, not hub_post/hub_delete")

    async def fake_save(self_=None, **kwargs):
        captured["saved"] = True
        return None

    monkeypatch.setattr(mod, "hub_put", fake_hub_put)
    monkeypatch.setattr(mod, "hub_post", boom)
    monkeypatch.setattr(mod, "hub_delete", boom)
    monkeypatch.setattr(Conversation, "save", fake_save)

    a = _make_action(methods=("put", "patch"))
    a.action_name = "update"
    local_parts = [{"user_id": "u-alice", "email": "alice@example.com", "name": "Alice"}]
    e = _make_entity(remote=True, members=local_parts)

    result = await mod.reflect_to_hub(a, e, {"title": "new-name"}, "put")

    # Reflected as a bare hub PUT with the body.
    assert captured["payload"] == {"title": "new-name"}
    assert captured["id"] == e.id
    assert captured["et"].value == "conversation"
    # Scalar hub fields merged onto the local row + broadcast.
    assert e.title == "new-name"
    assert captured.get("saved") is True
    # Returned the MERGED LOCAL entity (a dict), carrying the new title.
    assert isinstance(result, dict)
    assert result["title"] == "new-name"
    # The LIST field was NOT clobbered — local normalized members preserved.
    assert e.members == local_parts
    assert result["members"] == local_parts


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_merge_hub_entity_skips_lists_and_unchanged_scalars(monkeypatch):
    """``_merge_hub_entity_into_local`` returns only the differing SCALAR api fields:
    unchanged scalars and list/dict fields are skipped."""
    from flow_sdk.server.routes._hub_reflect import _merge_hub_entity_into_local

    e = _make_entity(remote=True, members=[{"user_id": "u1"}])
    e.title = "old"
    updates = _merge_hub_entity_into_local(
        e,
        {
            "title": "new",                              # scalar, changed → applied
            "message_status_visible": True,              # scalar, unchanged → skipped
            "members": [{"user_id": "hub"}],        # list → skipped
            "not_a_field_xyz": "z",                      # not an api field → skipped
        },
    )
    assert updates == {"title": "new"}


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

    a = _make_action(methods=("delete",))
    e = _make_entity(remote=True, members=[{"user_id": "u-bob"}])

    result = await mod.reflect_to_hub(a, e, {"user_id": "u-bob"}, "delete")

    # Body forwarded verbatim — the new identifier shape, no member_through envelope.
    assert captured["payload"] == {"user_id": "u-bob"}
    assert captured["action"] == "members"
    assert captured["et"].value == "conversation"
    assert captured["id"] == e.id
    # Roster re-fetched after the remove and mirrored onto the local row.
    assert result == [{"user_id": "u-alice", "role": "owner", "status": "approved"}]
    assert e.members == [{"user_id": "u-alice", "role": "owner", "status": "approved"}]
    assert captured.get("saved") is True


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_reflect_to_hub_put_members_targets_action_endpoint_and_refreshes_roster(monkeypatch):
    """PUT members (role change): must go to ``hub_put(..., action='members')``
    — the entity-action endpoint — NOT the bare entity update branch, which
    would silently write the member selector onto the conversation row. Like
    DELETE, the hub returns a message, so the canonical roster is re-fetched
    and mirrored onto the local row."""
    import flow_sdk.server.routes._hub_reflect as mod

    captured = {}

    async def fake_hub_put(entity_type, entity_id=None, payload=None, action=None, **kwargs):
        captured["payload"] = payload
        captured["action"] = action
        captured["et"] = entity_type
        captured["id"] = entity_id
        return {"message": "Replaced role of user u-bob to editor"}

    async def fake_hub_get(entity_type, entity_id=None, action=None, **kwargs):
        # Canonical roster after the change — bob is now editor.
        return [
            {"user_id": "u-alice", "role": "owner", "status": "approved"},
            {"user_id": "u-bob", "role": "editor", "status": "approved"},
        ]

    async def fake_save(self_=None, **kwargs):
        captured["saved"] = True
        return None

    monkeypatch.setattr(mod, "hub_put", fake_hub_put)
    monkeypatch.setattr(mod, "hub_get", fake_hub_get)
    monkeypatch.setattr(Conversation, "save", fake_save)

    a = _make_action(methods=("put",))
    e = _make_entity(remote=True, members=[{"user_id": "u-bob", "role": "member"}])

    result = await mod.reflect_to_hub(a, e, {"user_id": "u-bob", "role": "editor"}, "put")

    # Selector + role forwarded verbatim to the members ACTION endpoint.
    assert captured["payload"] == {"user_id": "u-bob", "role": "editor"}
    assert captured["action"] == "members"
    assert captured["et"].value == "conversation"
    assert captured["id"] == e.id
    # Roster re-fetched after the change and mirrored onto the local row.
    assert result[1]["role"] == "editor"
    assert e.members[1]["role"] == "editor"
    assert captured.get("saved") is True


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_reflect_to_hub_put_members_denial_propagates(monkeypatch):
    """A hub rejection of a role change (e.g. 403 from the ``can_assign``
    ceiling) must propagate as HubError — never be swallowed into a local
    no-op success."""
    import flow_sdk.server.routes._hub_reflect as mod

    async def fake_hub_put(entity_type, entity_id=None, payload=None, action=None, **kwargs):
        raise HubError(403, "Not allowed to change this role")

    monkeypatch.setattr(mod, "hub_put", fake_hub_put)

    a = _make_action(methods=("put",))
    e = _make_entity(remote=True, members=[{"user_id": "u-bob", "role": "member"}])

    with pytest.raises(HubError) as exc_info:
        await mod.reflect_to_hub(a, e, {"user_id": "u-bob", "role": "owner"}, "put")
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_reflect_to_hub_skips_unknown_entity_type(monkeypatch):
    """Entities whose ``type`` isn't a builtin enum value have no hub
    representation — reflection must raise HubError so the caller falls
    through to local."""
    import flow_sdk.server.routes._hub_reflect as mod

    a = _make_action(methods=("get",))
    e = _make_entity(remote=True)
    e.type = "some-plugin-defined-type"  # not in BuiltinEntityType

    with pytest.raises(HubError):
        await mod.reflect_to_hub(a, e, {}, "get")


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
async def test_mirror_caches_roster_on_any_entity_type(monkeypatch):
    """``members`` is now on the Entity base, so the roster mirror fires for
    EVERY remote type — org/team/user included, not just conversation/project
    which used to declare their own field. Previously this asserted a no-op skip
    for a field-less entity; that entity no longer exists."""
    from flow_sdk.builtin.user import User
    from flow_sdk.server.routes._hub_reflect import mirror_hub_response_into_local

    async def fake_save(self_=None, **kwargs):
        return None

    monkeypatch.setattr(User, "save", fake_save)
    u = User(id="u-1")
    await mirror_hub_response_into_local(u, "members", [{"user_id": "x", "role": "member"}])
    assert u.members == [{"user_id": "x", "role": "member"}]
