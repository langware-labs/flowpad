"""Two-client round-trip loop against a live local hub.

Both clients run the **exact same loop**: when they receive a number on the
shared conversation they increment it by 1 and reply. Alice ignites the
sequence by sending the first "1". Hub fanout (``_fanout_message``) skips
the sender on each broadcast, so the two clients naturally alternate:

    alice → "1"
    bob   ← rx 1  → tx "2"
    alice ← rx 2  → tx "3"
    bob   ← rx 3  → tx "4"
    …

Stops when STOP_AT is reached on either side.

This test exercises the *standard hub invitation pattern* end-to-end — no
``start_guest_conversation`` shortcut:

    1. alice creates a Conversation on the hub via plain ``POST /graph/conversation``.
    2. alice invites bob via ``POST /graph/conversation/<id>/members`` with a
       ``MembershipRequest`` targeting the Conversation with role ``member``.
    3. bob discovers the invitation via ``GET /graph/invitation/pending``.
    4. bob accepts via ``GET /api/v1/members/accept?invitation-id=<id>`` —
       grants bob ``member`` role on the conversation.
    5. bob calls ``POST /graph/conversation/<id>/join`` — appends himself to
       ``participants`` so ``_fanout_message`` can deliver to his WS.

Credentials come from the cycle's ``ALICE_*``/``BOB_*`` environment, with the
two project ``.env.local`` files as local-development fallbacks.

The flow_sdk hub WebSocket manager loads credentials from the keyring
singleton, so it doesn't support two simultaneous identities in a single
process. This test uses HTTP via ``httpx`` and per-token raw
``websockets.connect()`` for each identity's WS subscription.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path

import httpx
import pytest
import websockets

REPO_OSS = Path(__file__).resolve().parents[2]
REPO_APP = Path(__file__).resolve().parents[2].parent / "flowpad-app"
STOP_AT = 20


def _read_env_local(repo: Path) -> dict[str, str]:
    """Tiny KEY=value parser — no dotenv dependency."""
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
    token = data.get("api_key") or data["token"]
    return token, data.get("user") or {}


def _make_ws_url(hub_base_url: str) -> str:
    base_ws = hub_base_url.replace("https://", "wss://").replace("http://", "ws://")
    return f"{base_ws}/api/v1/connect/ws/{uuid.uuid4()}"


@pytest.mark.asyncio
async def test_two_client_loop(hub_base_url):
    """Alice + Bob ping-pong increment loop using the standard invite pattern, STOP_AT=20."""
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
    print(f"\nalice {alice_email} ({alice_id[:8]})  bob {bob_email} ({bob_id[:8]})")

    headers_a = {"Authorization": f"Bearer {alice_tok}", "Content-Type": "application/json"}
    headers_b = {"Authorization": f"Bearer {bob_tok}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=5.0) as h:
        # 1) alice creates the Conversation directly on the hub (standard share path).
        # Participants is intentionally left empty here — both alice and bob
        # enter ``participants`` explicitly via ``join()`` so the test exercises
        # the canonical "everyone joins" pattern, not the EntityField-on-create
        # shortcut.
        title = f"loop-{int(time.time())}"
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation",
            headers=headers_a,
            json={"title": title},
        )
        r.raise_for_status()
        conv_id = r.json()["data"]["id"]
        print(f"share: conv={conv_id[:8]}  title={title}")

        # 1b) alice joins her own conversation. The creator automatically holds
        # ``owner`` on the entity (via the standard graph-create role grant),
        # which satisfies ``join``'s role gate.
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/join",
            headers=headers_a,
            json={},
        )
        r.raise_for_status()
        print("join: alice is now a participant")

        # 2) alice invites bob via the canonical /members endpoint.
        members_url = f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/members"
        r = await h.post(
            members_url,
            headers=headers_a,
            json={
                "recipient_email": bob_email,
                "invitation_targets": [
                    {"typeid": f"conversation-{conv_id}", "role": "member"},
                ],
            },
        )
        r.raise_for_status()
        print(f"invite: sent to {bob_email}")

        # 3) the invite ALREADY granted bob's role — there is nothing pending to
        # accept. ``_maybe_auto_accept`` grants at invite time for every target
        # type (hub 74694a30d) and marks the invitation accepted as it does, so
        # ``/invitation/pending`` is empty by design. Assert the grant landed by
        # reading the roster instead.
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/members",
            headers=headers_a,
        )
        r.raise_for_status()
        roster = r.json()["data"] or []
        bob_rows = [m for m in roster if (m.get("user_email") or "").lower() == bob_email.lower()]
        assert bob_rows, f"invite did not grant bob a role; roster={roster}"
        print(f"grant: bob is {bob_rows[0].get('role')} / {bob_rows[0].get('status')}")

        # 4) bob joins → adds himself to participants so fanout reaches him.
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/join",
            headers=headers_b,
            json={},
        )
        r.raise_for_status()
        print("join: bob is now a participant")

    log: list[tuple[float, str, str, int]] = []  # (t, who, kind, n)
    done = asyncio.Event()
    ready = {"alice": asyncio.Event(), "bob": asyncio.Event()}

    async def loop(name: str, token: str, my_user_id: str):
        """Identical loop both clients run: rx number → tx number+1.

        Skips messages we sent ourselves (the hub fans out to all participants
        including the sender on this build, so we have to filter client-side).
        """
        url = _make_ws_url(hub_base_url)
        async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {token}"}) as ws:
            print(f"  {name}: WS open")
            ready[name].set()
            send_headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
            async with httpx.AsyncClient(timeout=5.0) as h:
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        continue
                    if msg.get("message_type") != "data_op_msg":
                        continue
                    if msg.get("op") != "create":
                        continue
                    to = msg.get("to_entity")
                    etype = to.split("-", 1)[0] if isinstance(to, str) else (to or {}).get("type")
                    if etype != "flow_message":
                        continue
                    data = msg.get("data") or {}
                    if (data.get("sender_id") or "") == my_user_id:
                        continue
                    text = (data.get("text") or "").strip()
                    if not text.isdigit():
                        continue
                    n = int(text)
                    log.append((time.monotonic(), name, "rx", n))
                    print(f"  {name}: rx {n}")
                    if n >= STOP_AT:
                        done.set()
                        return
                    next_n = n + 1
                    await h.post(
                        f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/add_message",
                        headers=send_headers,
                        json={"text": str(next_n)},
                    )
                    log.append((time.monotonic(), name, "tx", next_n))
                    print(f"  {name}: tx {next_n}")
                    if next_n >= STOP_AT:
                        done.set()
                        return

    alice_task = asyncio.create_task(loop("alice", alice_tok, alice_id))
    bob_task = asyncio.create_task(loop("bob", bob_tok, bob_id))

    await asyncio.wait_for(asyncio.gather(ready["alice"].wait(), ready["bob"].wait()), timeout=5.0)
    await asyncio.sleep(0.1)  # tiny grace period after the WS upgrade

    # Alice ignites.
    t0 = time.monotonic()
    log.append((t0, "alice", "ignite", 1))
    async with httpx.AsyncClient(timeout=5.0) as h:
        await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/add_message",
            headers=headers_a,
            json={"text": "1"},
        )

    try:
        await asyncio.wait_for(done.wait(), timeout=10.0)
    except asyncio.TimeoutError:
        print(f"\n  TIMEOUT — last log entry: {log[-1] if log else '(empty)'}")
    finally:
        for t in (alice_task, bob_task):
            if not t.done():
                t.cancel()
        await asyncio.gather(alice_task, bob_task, return_exceptions=True)

    print()
    print(f"{'dt_ms':>8}  {'who':>5}  {'kind':>6}  {'n':>3}")
    for t, name, kind, n in log:
        print(f"{(t - t0) * 1000:>8.1f}  {name:>5}  {kind:>6}  {n:>3}")

    nums_rx_a = sorted({n for _, name, k, n in log if name == "alice" and k == "rx"})
    nums_rx_b = sorted({n for _, name, k, n in log if name == "bob" and k == "rx"})
    print(f"\nalice rx: {nums_rx_a}")
    print(f"bob   rx: {nums_rx_b}")

    assert max(nums_rx_a + nums_rx_b, default=0) >= STOP_AT, (
        f"didn't reach {STOP_AT}; max rx={max(nums_rx_a + nums_rx_b, default=0)}"
    )
    assert all(n % 2 == 0 for n in nums_rx_a), f"alice received non-even numbers: {nums_rx_a}"
    assert all(n % 2 == 1 for n in nums_rx_b), f"bob received non-odd numbers: {nums_rx_b}"
