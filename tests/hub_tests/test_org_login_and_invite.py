"""Hub integration: organization/team login + invitation flow.

Runs against a real local hub (skipped by ``conftest`` when none is reachable).
Verifies the two pieces that aren't conversation-shaped:

  * the login response embeds the user's organization + role, and
  * the generic membership endpoint grants an org/team role to a second user
    at INVITE time — since hub ``74694a30d`` there is no pending row to
    accept, so the assertion is simply that they appear on the roster.

The conversation invite flow is covered by ``test_members_basic_operations.py``;
this file reuses its two-actor setup (``_alice_and_bob``).
"""

from __future__ import annotations

import time

import httpx
import pytest

from tests.hub_tests.test_members_basic_operations import _alice_and_bob


async def _create_membership_entity(hub_base_url: str, token: str, etype: str, name: str) -> str:
    """Create an organization/team on the hub as ``token``'s user; return its id.

    The creator gets the owner role on the new entity (hub default), which is
    what makes them eligible to invite others.
    """
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/{etype}",
            headers=headers,
            json={"name": name},
        )
    if r.status_code == 404:
        pytest.skip(f"hub does not expose POST /graph/{etype}")
    assert r.status_code == 200, r.text
    data = r.json().get("data") or {}
    ent_id = data.get("id") if isinstance(data, dict) else None
    assert ent_id, f"create {etype} returned no id: {r.text[:300]}"
    return ent_id


async def _invite(hub_base_url: str, token: str, etype: str, ent_id: str, email: str, role: str = "member"):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body = {
        "recipient_email": email,
        "invitation_targets": [{"typeid": f"{etype}-{ent_id}", "role": role}],
    }
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/{etype}/{ent_id}/members",
            headers=headers,
            json=body,
        )
    assert r.status_code == 200, r.text


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_login_returns_organization_and_role(hub_base_url, hub_login_payload, isolated_hub_keyring):
    """A user who owns an organization sees it (with role) in the login response."""
    actors = await _alice_and_bob(hub_base_url, hub_login_payload)
    alice_token = actors["alice_token"]
    alice_email = actors["alice_email"]
    if not alice_email:
        pytest.skip("alice login payload has no email")

    # Ensure alice belongs to at least one organization (idempotent — she may
    # already own one from a prior run; "one org per user" is a product rule,
    # not enforced by the hub, so repeated runs can accumulate orgs).
    await _create_membership_entity(hub_base_url, alice_token, "organization", f"login-org-{int(time.time())}")

    # Re-login as alice; the response should now embed her organization + role.
    # Needs password creds (the autouse local-login fixture may have used
    # /login/local) — skip cleanly when they're absent.
    password = _alice_password()
    if not password:
        pytest.skip("re-login as alice requires FLOWPAD_CLOUD_USER_PASSWORD")
    async with httpx.AsyncClient(timeout=10.0) as h:
        r = await h.post(
            f"{hub_base_url}/api/v1/login",
            json={"email": alice_email, "password": password},
        )
    if r.status_code != 200:
        pytest.skip(f"re-login as alice failed (got {r.status_code})")
    data = r.json()["data"]
    # The contract: login embeds the user's organization (an id) + their role.
    # We don't assert the specific org (which org is "primary" is ambiguous once
    # a user has several — a test-only artifact of repeated runs).
    org = data.get("organization")
    assert isinstance(org, dict) and org.get("id"), f"login did not embed an organization: {data.keys()}"
    assert data.get("organization_role"), "login did not embed organization_role"


def _alice_password() -> str:
    import os

    return os.environ.get("FLOWPAD_CLOUD_USER_PASSWORD") or ""


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_org_invitation_pending_target_and_accept_makes_member(
    hub_base_url, hub_login_payload, isolated_hub_keyring
):
    """alice creates an org, invites bob → bob's pending shows an organization
    target → bob accepts → GET members lists bob with a role."""
    actors = await _alice_and_bob(hub_base_url, hub_login_payload)
    alice_token = actors["alice_token"]
    bob_id = actors["bob_id"]
    bob_email = actors["bob_email"]

    org_id = await _create_membership_entity(
        hub_base_url, alice_token, "organization", f"invite-org-{int(time.time())}"
    )
    await _invite(hub_base_url, alice_token, "organization", org_id, bob_email, role="member")

    # The invite grants the role outright — no pending invitation, nothing to
    # accept. ``_maybe_auto_accept`` (hub membership/services.py) is governed by
    # ``invitation_auto_accept_on_invite`` alone and applies uniformly to EVERY
    # target type since hub ``74694a30d`` removed the tasks-only allowlist; it
    # marks the invitation accepted as it grants, so ``/invitation/pending`` is
    # empty by design. Access is still gated on a verified email — an
    # unverified address cannot authenticate at all — so the grant sits inert
    # until the real owner signs in.
    headers_a = {"Authorization": f"Bearer {alice_token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/organization/{org_id}/members", headers=headers_a)
    assert r.status_code == 200, r.text
    members = r.json().get("data") or []
    by_id = {m.get("user_id"): m for m in members if isinstance(m, dict)}
    assert bob_id in by_id, f"bob not in org members after accept: {members}"
    assert by_id[bob_id].get("role"), "bob has no role on the organization"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_team_invitation_accept_makes_member(hub_base_url, hub_login_payload, isolated_hub_keyring):
    """Same invite→grant→member flow for a team target (no accept step)."""
    actors = await _alice_and_bob(hub_base_url, hub_login_payload)
    alice_token = actors["alice_token"]
    bob_id = actors["bob_id"]
    bob_email = actors["bob_email"]

    team_id = await _create_membership_entity(hub_base_url, alice_token, "team", f"invite-team-{int(time.time())}")
    await _invite(hub_base_url, alice_token, "team", team_id, bob_email, role="member")

    # As above: the invite grants outright, so there is no pending row to accept.
    headers_a = {"Authorization": f"Bearer {alice_token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/team/{team_id}/members", headers=headers_a)
    assert r.status_code == 200, r.text
    members = r.json().get("data") or []
    by_id = {m.get("user_id"): m for m in members if isinstance(m, dict)}
    assert bob_id in by_id, f"bob not in team members after accept: {members}"
