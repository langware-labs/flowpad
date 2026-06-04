"""Sharing into an EXISTING conversation must NOT mint a new invitation.

This is the regression guard for the duplicate-conversation / per-message email
bug: once alice has shared a conversation with bob (one invitation), every
further message into that SAME conversation — including ones that carry a shared
asset — routes through ``add_message`` only. ``add_message`` never calls
``share()`` / ``members`` / ``Invitation``, so the invitation count for the
conversation must stay at exactly 1.

Mirrors the harness in ``test_share_with_recipients.py`` (env-mode alice login
via fixtures; bob driven over raw HTTP from flowpad-app/.env.local).
"""
from __future__ import annotations

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


async def _count_invitations(hub_base_url: str, headers_b: dict, bob_email: str) -> int:
    """How many invitations bob currently has for the (any) conversation."""
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/invitation/pending", headers=headers_b)
        r.raise_for_status()
        pending = r.json()["data"] or []
    return len([inv for inv in pending if inv.get("recipient_email") == bob_email])


@pytest.mark.asyncio
async def test_message_into_existing_conversation_sends_no_new_invite(
    hub_base_url, hub_login_payload, isolated_hub_keyring
):
    from flow_sdk.cli.auth.credentials import UserHubCredentials, save_credentials
    from flow_sdk.builtin.conversation import Conversation

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
    headers_b = {"Authorization": f"Bearer {bob_token}", "Content-Type": "application/json"}

    # Baseline: invitations bob already has (other tests may have left some).
    base = await _count_invitations(hub_base_url, headers_b, bob_email)

    # First contact: share creates exactly ONE new invitation.
    title = f"share-existing-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    conv = Conversation(title=title)
    await conv.share(recipients=[bob_email])
    after_share = await _count_invitations(hub_base_url, headers_b, bob_email)
    assert after_share == base + 1, f"share should add exactly one invite ({base} → {after_share})"

    # Now send several messages into the SAME conversation. None may mint an
    # invitation — this is the converged-share invariant (re-share threads in).
    await conv.add_message("first reply")
    await conv.add_message("second reply")
    after_msgs = await _count_invitations(hub_base_url, headers_b, bob_email)
    assert after_msgs == after_share, (
        f"messages into an existing conversation must not mint invites "
        f"({after_share} → {after_msgs})"
    )
