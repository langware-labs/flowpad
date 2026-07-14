"""Conversation between alice and bob — both sides' hub worldview must agree.

Standard invite pattern (no shortcuts):
  1. alice creates a Conversation + joins (owner).
  2. alice invites bob via /members; bob accepts (/members/accept) + joins.
  3. alice and bob each send a message (POST /conversation/<id>/add_message).
  4. Validate BOTH users' worldview on the hub: querying as alice AND as bob,
     the conversation exists and BOTH messages are visible to each.

Credentials come from the cycle's ``ALICE_*``/``BOB_*`` environment, with the
two project ``.env.local`` files as local-development fallbacks.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import httpx
import pytest

REPO_OSS = Path(__file__).resolve().parents[2]
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


async def _login(hub_base_url: str, email: str, password: str) -> tuple[str, dict]:
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(f"{hub_base_url}/api/v1/login", json={"email": email, "password": password})
    r.raise_for_status()
    data = r.json()["data"]
    return data.get("api_key") or data["token"], data.get("user") or {}


async def _accept_invitation(h: httpx.AsyncClient, hub_base_url: str, headers: dict, invitation_id: str) -> None:
    # Browser-oriented endpoint: ALWAYS 302s. login redirect = failure;
    # conversation/flow_message redirect (or 200/409) = success.
    r = await h.get(
        f"{hub_base_url}/api/v1/graph/members/accept",
        headers=headers,
        params={"invitation-id": invitation_id},
    )
    if r.status_code in (301, 302, 303, 307, 308):
        loc = (r.headers.get("location") or r.headers.get("Location") or "").lower()
        assert "login" not in loc, f"accept bounced to login (unauthenticated): {loc[:200]}"
        return
    r.raise_for_status()


async def _messages(h: httpx.AsyncClient, hub_base_url: str, headers: dict, conv_id: str) -> list[dict]:
    r = await h.get(f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/flow_message", headers=headers)
    r.raise_for_status()
    return r.json().get("data") or []


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_conversation_worldview_consistent_for_both(hub_base_url):
    """A conversation + two messages between alice and bob is visible, identically,
    in both alice's and bob's hub worldview."""
    oss_env = _read_env_local(REPO_OSS)
    app_env = _read_env_local(REPO_APP)
    alice_email = os.environ.get("ALICE_EMAIL") or oss_env.get("FLOWPAD_CLOUD_USER_EMAIL")
    alice_pw = os.environ.get("ALICE_PW") or oss_env.get("FLOWPAD_CLOUD_USER_PASSWORD")
    bob_email = os.environ.get("BOB_EMAIL") or app_env.get("FLOWPAD_CLOUD_USER_EMAIL")
    bob_pw = os.environ.get("BOB_PW") or app_env.get("FLOWPAD_CLOUD_USER_PASSWORD")
    if not (alice_email and alice_pw and bob_email and bob_pw):
        pytest.skip("missing cycle actor credentials and .env.local fallbacks")

    alice_tok, alice_user = await _login(hub_base_url, alice_email, alice_pw)
    bob_tok, bob_user = await _login(hub_base_url, bob_email, bob_pw)
    alice_id, bob_id = alice_user["id"], bob_user["id"]
    headers_a = {"Authorization": f"Bearer {alice_tok}", "Content-Type": "application/json"}
    headers_b = {"Authorization": f"Bearer {bob_tok}", "Content-Type": "application/json"}

    msg_alice = f"Hello from Alice {int(time.time())}"
    msg_bob = f"Hi from Bob {int(time.time())}"

    async with httpx.AsyncClient(timeout=5.0) as h:
        # 1) alice creates the conversation + joins (owner).
        title = f"worldview-{int(time.time())}"
        r = await h.post(f"{hub_base_url}/api/v1/graph/conversation", headers=headers_a, json={"title": title})
        r.raise_for_status()
        conv_id = r.json()["data"]["id"]
        (await h.post(f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/join", headers=headers_a, json={})).raise_for_status()

        # 2) alice invites bob; bob accepts + joins.
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/members",
            headers=headers_a,
            json={"recipient_email": bob_email, "invitation_targets": [{"typeid": f"conversation-{conv_id}", "role": "member"}]},
        )
        r.raise_for_status()
        r = await h.get(f"{hub_base_url}/api/v1/graph/invitation/pending", headers=headers_b)
        r.raise_for_status()
        pending = [inv for inv in (r.json()["data"] or []) if inv.get("recipient_email") == bob_email and not inv.get("accepted")]
        # Narrow to THIS conversation (stale invites from prior runs may linger).
        mine = [p for p in pending if (p.get("conversation") or {}).get("id") == conv_id] or pending
        mine.sort(key=lambda x: x.get("created_date") or "", reverse=True)
        assert mine, f"bob has no pending invitation; got {pending}"
        await _accept_invitation(h, hub_base_url, headers_b, mine[0]["id"])
        (await h.post(f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/join", headers=headers_b, json={})).raise_for_status()

        # 3) both send a message (after bob joined, so fanout + scoped reads include both).
        (await h.post(f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/add_message", headers=headers_a, json={"text": msg_alice})).raise_for_status()
        (await h.post(f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/add_message", headers=headers_b, json={"text": msg_bob})).raise_for_status()

        # 4) Both worldviews must contain the conversation + BOTH messages.
        for who, headers in (("alice", headers_a), ("bob", headers_b)):
            # The conversation itself is visible.
            r = await h.get(f"{hub_base_url}/api/v1/graph/conversation/{conv_id}", headers=headers)
            assert r.status_code == 200, f"{who} cannot see the conversation: {r.status_code} {r.text[:200]}"
            assert (r.json().get("data") or {}).get("id") == conv_id, f"{who}: wrong conversation payload"

            # Both messages are visible.
            texts = {(m.get("text") or "").strip() for m in await _messages(h, hub_base_url, headers, conv_id)}
            assert msg_alice in texts, f"{who}'s worldview is missing alice's message. saw: {sorted(texts)}"
            assert msg_bob in texts, f"{who}'s worldview is missing bob's message. saw: {sorted(texts)}"

        # Sanity: both participants are on the roster.
        r = await h.get(f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/members", headers=headers_a)
        if r.status_code == 200:
            by_id = {m.get("user_id") for m in (r.json().get("data") or [])}
            assert alice_id in by_id and bob_id in by_id, f"roster missing a participant: {by_id}"
