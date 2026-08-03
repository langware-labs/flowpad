"""Sharing into an EXISTING conversation must NOT mint a new invitation.

This is the regression guard for the duplicate-conversation / per-message email
bug: once alice has shared a conversation with bob (one invitation), every
further message into that SAME conversation — including ones that carry a shared
asset — routes through ``add_message`` only. ``add_message`` never calls
``share()`` / ``members`` / ``Invitation``, so the invitation count for the
conversation must stay at exactly 1.

Mirrors the harness in ``test_share_with_recipients.py`` (env-mode alice login
via fixtures; bob driven over raw HTTP from the cycle env, with a repo fallback).
"""

from __future__ import annotations

import os
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


async def _count_grants(hub_base_url: str, headers_a: dict, conv_id: str, bob_email: str) -> int:
    """How many roster rows bob holds on THIS conversation.

    The invariant under test is "first contact grants access once; further
    messages into the same thread don't re-grant" — it used to be counted as
    pending invitations, but the hub now grants at invite time and marks the
    invitation accepted (74694a30d), so ``/invitation/pending`` is always empty
    and the old count was 0 → 0. Counting roster rows measures the same thing
    where it is now observable, and scoped to one conversation rather than
    globally, so a stale invite from another test can't drift the baseline.
    """
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/members", headers=headers_a)
        r.raise_for_status()
        roster = r.json()["data"] or []
    return len([m for m in roster if (m.get("user_email") or "").lower() == bob_email.lower()])


@pytest.mark.asyncio
async def test_message_into_existing_conversation_sends_no_new_invite(
    hub_base_url, hub_login_payload, isolated_hub_keyring
):
    from flow_sdk.builtin.conversation import Conversation
    from tests.hub_tests._local_login import login_as

    # login_as persists BOTH halves (token + user record); a token-only write is
    # a half-logged-in state that share() rejects.
    alice_key = login_as(hub_login_payload)
    headers_a = {"Authorization": f"Bearer {alice_key}", "Content-Type": "application/json"}

    app_env = _read_env_local(REPO_APP)
    bob_email = os.environ.get("BOB_EMAIL") or app_env.get("FLOWPAD_CLOUD_USER_EMAIL")
    bob_pw = os.environ.get("BOB_PW") or app_env.get("FLOWPAD_CLOUD_USER_PASSWORD")
    if not bob_email or not bob_pw:
        pytest.skip("missing BOB_EMAIL/BOB_PW and flowpad-app fallback credentials")

    # Bob is never driven here — the grant is read from alice's roster, so his
    # credentials are only needed to prove the account resolves. (The old
    # version logged him in to read HIS pending-invitation list; that list is
    # empty by design now.)

    # First contact: share grants bob exactly ONE role on the conversation.
    title = f"share-existing-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    conv = Conversation(title=title)
    await conv.share(recipients=[bob_email])
    after_share = await _count_grants(hub_base_url, headers_a, conv.id, bob_email)
    assert after_share == 1, f"share should grant bob exactly one role, got {after_share}"

    # Now send several messages into the SAME conversation. None may re-grant —
    # this is the converged-share invariant (re-share threads in).
    await conv.add_message("first reply")
    await conv.add_message("second reply")
    after_msgs = await _count_grants(hub_base_url, headers_a, conv.id, bob_email)
    assert after_msgs == after_share, (
        f"messages into an existing conversation must not re-grant ({after_share} → {after_msgs})"
    )
