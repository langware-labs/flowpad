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


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_merge_hub_entity_skips_roster_and_unchanged_scalars(monkeypatch):
    """``_merge_hub_entity_into_local`` returns the differing api fields, skipping
    unchanged scalars, non-fields, and the denylisted roster (``members``)."""
    from flow_sdk.server.routes._hub_reflect import _merge_hub_entity_into_local

    e = _make_entity(remote=True, members=[{"user_id": "u1"}])
    e.title = "old"
    updates = _merge_hub_entity_into_local(
        e,
        {
            "title": "new",  # scalar, changed → applied
            "git_sharing_enabled": False,  # scalar, unchanged → skipped
            "members": [{"user_id": "hub"}],  # denylisted roster → skipped
            "not_a_field_xyz": "z",  # not an api field → skipped
        },
    )
    assert updates == {"title": "new"}


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_merge_hub_entity_merges_hub_modeled_collection_but_skips_roster():
    """The hub is the source of truth, so a hub-modeled COLLECTION field (a task's
    ``artifacts``) merges onto the local row for immediate reflection — while the
    denylisted roster/projection collections (``members`` / ``message_ids``) are
    never overwritten by a bare entity PUT response."""
    from flow_sdk.builtin.task import Task
    from flow_sdk.server.routes._hub_reflect import _merge_hub_entity_into_local

    t = Task(id="task-x", title="old", remote=True)
    arts = [{"path": "/p/repo", "label": "repo", "git_origin": {"kind": "git"}}]
    updates = _merge_hub_entity_into_local(
        t,
        {
            "title": "new",  # scalar, changed → applied
            "artifacts": arts,  # hub-modeled collection → applied
            "members": [{"user_id": "h"}],  # denylisted roster → skipped
            "message_ids": ["m1"],  # denylisted projection → skipped
        },
    )
    assert updates == {"title": "new", "artifacts": arts}


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


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_mirror_learns_a_changed_roster_into_the_address_book(monkeypatch):
    """A member's email that arrives via the roster mirror reaches their contact:
    the conversation sync skips a roster it finds already stored, so the mirror
    is the only place that sees it. An unchanged roster learns nothing."""
    import flow_sdk.app.actions.flow_message_action as fma
    from flow_sdk.server.routes._hub_reflect import mirror_hub_response_into_local

    learned: list[list[dict]] = []

    async def fake_learn(participants):
        learned.append(list(participants))
        return len(participants)

    async def fake_save(self_=None, **kwargs):
        return None

    monkeypatch.setattr(fma, "_learn_address_book", fake_learn)
    monkeypatch.setattr(Conversation, "save", fake_save)
    roster = [{"user_id": "u-bob", "name": "Bob", "email": "bob@example.com", "role": "member"}]
    e = _make_entity(remote=True, members=[{"user_id": "u-bob", "name": "Bob"}])

    await mirror_hub_response_into_local(e, "members", roster)
    assert learned == [roster]

    await mirror_hub_response_into_local(e, "members", roster)
    assert learned == [roster]
