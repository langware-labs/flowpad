"""Hub-level tests for the generic ``members`` action.

The generic ``members`` action lives in ``flow_sdk/app/actions/members_action.py``
and is reflected to the hub by the dispatcher in
``flow_sdk/server/routes/_hub_reflect.py``. These tests verify the hub side of
the contract — that ``GET /graph/<type>/<id>/members`` returns participants
with roles for any entity that supports membership.

Invitation (the "create membership" half) is already covered by
``test_share_with_recipients.py``; this file picks up where that one leaves
off and exercises the read / remove / type-agnostic surface.

Hub-side endpoint shape (what these tests assume):
    GET /api/v1/graph/conversation/{id}/members
        → 200 { status: SUCCESS, data: [{user_id, user_name, user_email, user_picture, role, status, ...}] }

The flow_sdk dispatcher (``_hub_reflect.py``) normalizes ``user_email``/
``user_name``/``user_picture`` to the client-side ``email``/``name``/``picture``
shape, so TS callers see the simpler form. These tests hit the hub directly
and therefore assert the hub-native field names.

Tests SKIP rather than fail when the hub returns 404, so this file
documents what the hub still needs to expose without blocking CI on the
out-of-tree hub work.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path

import httpx
import pytest


REPO_APP = Path(__file__).resolve().parents[2].parent / "flowpad-app"


def _read_env_local(repo: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    path = repo / ".env.local"
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


async def _alice_and_bob(hub_base_url: str, hub_login_payload: dict):
    """Save alice's creds and resolve bob's via the sibling repo's .env.local.

    Mirrors the pattern in ``test_share_with_recipients.py`` so the two
    test files stay parallel.
    """
    from flow_sdk.cli.auth.credentials import UserHubCredentials, save_credentials

    alice_token = hub_login_payload.get("api_key") or hub_login_payload["token"]
    alice_user = hub_login_payload.get("user") or {}
    save_credentials(UserHubCredentials(api_key=alice_token, user=alice_user))

    app_env = _read_env_local(REPO_APP)
    bob_email = app_env.get("FLOWPAD_CLOUD_USER_EMAIL")
    bob_pw = app_env.get("FLOWPAD_CLOUD_USER_PASSWORD")
    if not bob_email or not bob_pw:
        pytest.skip("missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD} in flowpad-app/.env.local")

    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(f"{hub_base_url}/api/v1/login", json={"email": bob_email, "password": bob_pw})
        r.raise_for_status()
        bob_data = r.json()["data"]
        bob_token = bob_data.get("api_key") or bob_data["token"]
        bob_id = (bob_data.get("user") or {})["id"]

    return {
        "alice_token": alice_token,
        "alice_id": alice_user["id"],
        "alice_email": alice_user.get("email"),
        "bob_token": bob_token,
        "bob_id": bob_id,
        "bob_email": bob_email,
    }


async def _bob_accept_and_join(hub_base_url: str, bob_token: str, bob_email: str, conv_id: str) -> None:
    """Bob walks the canonical invite→accept→join chain over raw HTTP."""
    headers_b = {"Authorization": f"Bearer {bob_token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/invitation/pending", headers=headers_b)
        r.raise_for_status()
        pending = r.json()["data"] or []
        matching = [inv for inv in pending if inv.get("recipient_email") == bob_email and not inv.get("accepted")]
        assert matching, f"bob has no pending invitation; got {pending}"
        matching.sort(key=lambda x: x.get("created_date") or "", reverse=True)
        invitation_id = matching[0]["id"]

        # The hub's members/accept is a browser-oriented endpoint: it ALWAYS
        # returns a 302 — to /login when unauthenticated (the accept did NOT
        # run), or to the landing /conversation/<id> (or /flow_message/<id>)
        # on a SUCCESSFUL authenticated accept (the role IS granted
        # server-side before the redirect). Mirror the production SDK's
        # handle_invitation_accept (flow_sdk/app/actions/flow_message_action.py
        # :2589-2619): do NOT follow the redirect (a second authed hop can
        # itself 302); read the Location and treat 200/409 or a redirect to
        # the conversation/flow_message landing as success, only a redirect to
        # login as failure. The old `raise_for_status()` rejected the
        # by-design 302 and failed every accept.
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/members/accept",
            headers=headers_b,
            params={"invitation-id": invitation_id},
        )
        if r.status_code not in (200, 409):
            if r.status_code in (301, 302, 303, 307, 308):
                location = (r.headers.get("location") or r.headers.get("Location") or "")
                low = location.lower()
                assert "login" not in low, (
                    f"accept redirected to login (request was unauthenticated); "
                    f"accept did not run. location={location[:200]}"
                )
                assert ("/conversation/" in location) or ("/flow_message/" in location), (
                    f"accept returned an unexpected redirect location={location[:200]}"
                )
            else:
                r.raise_for_status()

        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/join",
            headers=headers_b,
            json={},
        )
        r.raise_for_status()


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_members_after_share_lists_both_with_roles(
    hub_base_url, hub_login_payload, isolated_hub_keyring
):
    """alice.share(recipients=[bob]) → bob accepts+joins → GET members returns both with roles."""
    from flow_sdk.builtin.conversation import Conversation

    actors = await _alice_and_bob(hub_base_url, hub_login_payload)
    alice_id = actors["alice_id"]
    bob_id = actors["bob_id"]
    bob_email = actors["bob_email"]

    title = f"members-after-share-{int(time.time())}"
    conv = Conversation(title=title)
    await conv.share(recipients=[bob_email])
    assert conv.remote is True

    await _bob_accept_and_join(hub_base_url, actors["bob_token"], bob_email, conv.id)

    # GET members directly against the hub — the same path the local-server
    # dispatcher would hit when reflecting the ``members`` action.
    headers_a = {"Authorization": f"Bearer {actors['alice_token']}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/members", headers=headers_a)

    if r.status_code == 404:
        pytest.skip(
            "hub does not yet expose GET /graph/conversation/<id>/members — "
            "the local dispatcher will fall back to the cached participants list."
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("status") == "SUCCESS", body
    members = body["data"] or []
    assert isinstance(members, list)
    assert len(members) >= 2, f"expected at least alice + bob, got {members}"

    by_id = {m.get("user_id"): m for m in members if m.get("user_id")}
    assert alice_id in by_id, f"alice missing from members: {members}"
    assert bob_id in by_id, f"bob missing from members: {members}"
    for m in (by_id[alice_id], by_id[bob_id]):
        assert m.get("role"), f"participant has no role: {m}"
        assert "user_email" in m, f"participant missing user_email key: {m}"
        assert "user_name" in m, f"participant missing user_name key: {m}"


@pytest.mark.asyncio
@pytest.mark.timeout(30)
@pytest.mark.xfail(
    reason=(
        "Hub-side bug: Conversation.leave returns 200 but the leaver's role "
        "is not actually revoked, so they still appear in get_approved_members. "
        "Root cause: bare ``except Exception: pass`` around ``self.remove_role`` "
        "in hub builtin/conversation.py:leave swallows the real failure. "
        "Fix lives in the hub repo, not flow_sdk."
    ),
    strict=True,
)
async def test_members_after_leave_excludes_leaver(
    hub_base_url, hub_login_payload, isolated_hub_keyring
):
    """After bob leaves the shared conversation, members no longer includes him."""
    from flow_sdk.builtin.conversation import Conversation

    actors = await _alice_and_bob(hub_base_url, hub_login_payload)
    alice_id = actors["alice_id"]
    bob_id = actors["bob_id"]
    bob_email = actors["bob_email"]

    title = f"members-after-leave-{int(time.time())}"
    conv = Conversation(title=title)
    await conv.share(recipients=[bob_email])
    await _bob_accept_and_join(hub_base_url, actors["bob_token"], bob_email, conv.id)

    members_url = f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/members"
    headers_a = {"Authorization": f"Bearer {actors['alice_token']}", "Accept": "application/json"}
    headers_b = {"Authorization": f"Bearer {actors['bob_token']}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=5.0) as h:
        pre = await h.get(members_url, headers=headers_a)
        if pre.status_code == 404:
            pytest.skip("hub does not expose GET /members yet")
        assert pre.status_code == 200, pre.text
        pre_ids = {m.get("user_id") for m in (pre.json().get("data") or [])}
        assert bob_id in pre_ids, f"bob should be a member before leave: {pre_ids}"

        # Try the canonical leave endpoint. If the hub doesn't expose one
        # yet, document the gap and skip — the test still proves the
        # post-share state is correct.
        leave = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/leave",
            headers=headers_b,
            json={},
        )
        if leave.status_code == 404:
            pytest.skip("hub does not expose POST /conversation/<id>/leave yet")
        assert leave.status_code in (200, 204), f"leave failed: {leave.status_code} {leave.text}"

        # Small settle window — the hub may apply the leave asynchronously.
        await asyncio.sleep(0.2)
        post = await h.get(members_url, headers=headers_a)
        assert post.status_code == 200, post.text
        post_ids = {m.get("user_id") for m in (post.json().get("data") or [])}
        assert bob_id not in post_ids, f"bob still listed post-leave: {post_ids}"
        assert alice_id in post_ids, f"alice missing post-leave: {post_ids}"


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_members_action_returns_role_per_participant(
    hub_base_url, hub_login_payload, isolated_hub_keyring
):
    """Every entry in the members list must carry the four canonical keys
    {user_id, email, name, role}. Future entity types reusing the same
    action depend on this shape."""
    from flow_sdk.builtin.conversation import Conversation

    actors = await _alice_and_bob(hub_base_url, hub_login_payload)
    bob_email = actors["bob_email"]

    title = f"members-shape-{int(time.time())}"
    conv = Conversation(title=title)
    await conv.share(recipients=[bob_email])
    await _bob_accept_and_join(hub_base_url, actors["bob_token"], bob_email, conv.id)

    members_url = f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/members"
    headers_a = {"Authorization": f"Bearer {actors['alice_token']}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(members_url, headers=headers_a)
        if r.status_code == 404:
            pytest.skip("hub does not expose GET /members yet")
        assert r.status_code == 200, r.text
        members = r.json().get("data") or []

    assert members, "expected at least one member"
    for m in members:
        # Hub-native shape — dispatcher normalizes ``user_email``/``user_name``
        # → ``email``/``name`` on the client side.
        for key in ("user_id", "user_email", "user_name", "role"):
            assert key in m, f"members entry missing {key!r}: {m}"
        # Role must be a non-empty string — every member has a hub-side role.
        assert isinstance(m["role"], str) and m["role"], f"empty/non-string role on member: {m}"
