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

Credentials come from the two project ``.env.local`` files (alice ←
flowpad-oss; bob ← flowpad-app), matching the two-instance manual
scenario.

The flow_sdk hub WebSocket manager loads credentials from the keyring
singleton, so it doesn't support two simultaneous identities in a single
process. This test uses the SDK for HTTP (``FlowpadClient``) but a raw
``websockets.connect()`` for the per-token WS subscription.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path

import httpx
import pytest
import websockets


REPO_OSS = Path("/Users/shlom/Documents/dev/flowpad-oss")
REPO_APP = Path("/Users/shlom/Documents/dev/flowpad-app")
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
    """Alice + Bob ping-pong increment loop, STOP_AT=20."""
    oss_env = _read_env_local(REPO_OSS)
    app_env = _read_env_local(REPO_APP)
    alice_email = oss_env.get("FLOWPAD_CLOUD_USER_EMAIL")
    alice_pw = oss_env.get("FLOWPAD_CLOUD_USER_PASSWORD")
    bob_email = app_env.get("FLOWPAD_CLOUD_USER_EMAIL")
    bob_pw = app_env.get("FLOWPAD_CLOUD_USER_PASSWORD")
    if not (alice_email and alice_pw and bob_email and bob_pw):
        pytest.skip("missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD} in flowpad-oss or flowpad-app .env.local")

    alice_tok, alice_user = await _login(hub_base_url, alice_email, alice_pw)
    bob_tok, bob_user = await _login(hub_base_url, bob_email, bob_pw)
    alice_id, bob_id = alice_user["id"], bob_user["id"]
    print(f"\nalice {alice_email} ({alice_id[:8]})  bob {bob_email} ({bob_id[:8]})")

    headers_a = {"Authorization": f"Bearer {alice_tok}", "Content-Type": "application/json"}
    headers_b = {"Authorization": f"Bearer {bob_tok}", "Content-Type": "application/json"}

    # Setup: alice creates a project + a guest conversation with bob (both end
    # up in ``participants``, which is what hub fanout iterates).
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/project",
            headers=headers_a,
            json={"name": f"loop-{int(time.time())}"},
        )
        r.raise_for_status()
        proj_id = r.json()["data"]["id"]

        r = await h.post(
            f"{hub_base_url}/api/v1/graph/project/{proj_id}/start_guest_conversation",
            headers=headers_a,
            json={"text": "init", "receiver_address": bob_id, "receiver_address_type": "id"},
        )
        r.raise_for_status()
        conv_id = r.json()["data"]["id"]
    print(f"project={proj_id[:8]}  conv={conv_id[:8]}")

    log: list[tuple[float, str, str, int]] = []   # (t, who, kind, n)
    done = asyncio.Event()
    ready = {"alice": asyncio.Event(), "bob": asyncio.Event()}

    async def loop(name: str, token: str, my_user_id: str):
        """The identical loop both clients run: rx number → tx number+1.

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
                    # Only act on someone else's messages — never on our own
                    # echoes (the hub fans both ways on this build).
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

    # Wait for both WS connections to be open before igniting.
    await asyncio.wait_for(asyncio.gather(ready["alice"].wait(), ready["bob"].wait()), timeout=5.0)
    await asyncio.sleep(0.1)   # tiny grace period after the WS upgrade

    # Alice ignites.
    t0 = time.monotonic()
    log.append((t0, "alice", "ignite", 1))
    async with httpx.AsyncClient(timeout=5.0) as h:
        await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/add_message",
            headers=headers_a,
            json={"text": "1"},
        )

    timed_out = False
    try:
        await asyncio.wait_for(done.wait(), timeout=10.0)
    except asyncio.TimeoutError:
        timed_out = True
        print(f"\n  TIMEOUT — last log entry: {log[-1] if log else '(empty)'}")
    finally:
        for t in (alice_task, bob_task):
            if not t.done():
                t.cancel()
        await asyncio.gather(alice_task, bob_task, return_exceptions=True)

    # Pretty-print the timeline.
    print()
    print(f"{'dt_ms':>8}  {'who':>5}  {'kind':>6}  {'n':>3}")
    for t, name, kind, n in log:
        print(f"{(t-t0)*1000:>8.1f}  {name:>5}  {kind:>6}  {n:>3}")

    # Assertions: we reached STOP_AT, and each side rx-ed only the "other-sender" half.
    nums_rx_a = sorted({n for _, name, k, n in log if name == "alice" and k == "rx"})
    nums_rx_b = sorted({n for _, name, k, n in log if name == "bob" and k == "rx"})
    print(f"\nalice rx: {nums_rx_a}")
    print(f"bob   rx: {nums_rx_b}")

    assert max(nums_rx_a + nums_rx_b, default=0) >= STOP_AT, (
        f"didn't reach {STOP_AT}; max rx={max(nums_rx_a + nums_rx_b, default=0)}"
    )
    # alice sees only bob's sends → even numbers; bob sees only alice's → odd numbers.
    assert all(n % 2 == 0 for n in nums_rx_a), f"alice received non-even numbers: {nums_rx_a}"
    assert all(n % 2 == 1 for n in nums_rx_b), f"bob received non-odd numbers: {nums_rx_b}"
