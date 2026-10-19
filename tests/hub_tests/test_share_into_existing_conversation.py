"""Messages in an EXISTING conversation must not disturb its assignment.

This is the regression guard for the duplicate-conversation / per-message email
bug: once Alice has shared a conversation with Bob (one durable membership), every
further message into that SAME conversation — including ones that carry a shared
asset — routes through ``add_message`` only. ``add_message`` never calls
``share()`` / ``members`` / ``Invitation``, so Bob's membership must stay singular
and approved and the conversation must not reappear as pending.

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

from tests.hub_tests._assignment import assert_auto_assigned

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


async def _member_rows(hub_base_url: str, headers_b: dict, conv_id: str, bob_id: str) -> list[dict]:
    """Return Bob's membership rows for one conversation."""
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/members",
            headers=headers_b,
        )
        r.raise_for_status()
        members = r.json().get("data") or []
    return [m for m in members if isinstance(m, dict) and m.get("user_id") == bob_id]


@pytest.mark.asyncio
async def test_message_into_existing_conversation_preserves_assignment(
    hub_base_url, hub_login_payload, isolated_hub_keyring
):
    from flow_sdk.builtin.conversation import Conversation
    from tests.hub_tests._local_login import login_as

    # login_as persists BOTH halves (token + user record); a token-only write is
    # a half-logged-in state that share() rejects.
    login_as(hub_login_payload)

    app_env = _read_env_local(REPO_APP)
    bob_email = os.environ.get("BOB_EMAIL") or app_env.get("FLOWPAD_CLOUD_USER_EMAIL")
    bob_pw = os.environ.get("BOB_PW") or app_env.get("FLOWPAD_CLOUD_USER_PASSWORD")
    if not bob_email or not bob_pw:
        pytest.skip("missing BOB_EMAIL/BOB_PW and flowpad-app fallback credentials")

    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(f"{hub_base_url}/api/v1/login", json={"email": bob_email, "password": bob_pw})
        r.raise_for_status()
        bob_data = r.json()["data"]
        bob_token = bob_data.get("api_key") or bob_data["token"]
        bob_id = (bob_data.get("user") or {})["id"]
    headers_b = {"Authorization": f"Bearer {bob_token}", "Content-Type": "application/json"}

    # First contact grants exactly one durable member assignment.
    title = f"share-existing-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    conv = Conversation(title=title)
    await conv.share(recipients=[bob_email])
    await assert_auto_assigned(
        hub_base_url,
        bob_token,
        entity_type="conversation",
        entity_id=conv.id,
        user_id=bob_id,
        expected_role="member",
    )
    after_share = await _member_rows(hub_base_url, headers_b, conv.id, bob_id)
    assert len(after_share) == 1, f"share should grant exactly one Bob membership: {after_share}"

    # Messages into the SAME conversation may not duplicate or mutate membership.
    await conv.add_message("first reply")
    await conv.add_message("second reply")
    after_msgs = await _member_rows(hub_base_url, headers_b, conv.id, bob_id)
    assert len(after_msgs) == 1, f"messages duplicated Bob's membership: {after_msgs}"
    assert (after_msgs[0].get("role"), after_msgs[0].get("status")) == (
        after_share[0].get("role"),
        after_share[0].get("status"),
    ), f"messages into an existing conversation changed Bob's assignment ({after_share} → {after_msgs})"
