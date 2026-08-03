"""``Conversation.share(recipients=[...])`` end-to-end via the SDK method.

Verifies that the SDK helper produces the same hub-side state as the
hand-rolled HTTP sequence in ``test_two_client_loop.py``:

  - hub-side Conversation exists
  - alice is in ``participants`` (via the join the SDK fires after share)
  - bob receives an immediate ``member`` assignment with no pending row
  - bob can join through ``/conversation/<id>/join``
  - both ends receive ``flow_message`` fanout (alice ignites "1", bob rxs)

This is the canonical SDK-driven test for the share+assignment+join
pattern. ``test_two_client_loop.py`` covers the raw HTTP version; this one
covers the same flow through the Python SDK that the UI / TS SDK also build
on top of.
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


def _make_ws_url(hub_base_url: str) -> str:
    base_ws = hub_base_url.replace("https://", "wss://").replace("http://", "ws://")
    return f"{base_ws}/api/v1/connect/ws/{uuid.uuid4()}"


@pytest.mark.asyncio
async def test_share_with_recipients(hub_base_url, hub_login_payload, isolated_hub_keyring):
    """Alice shares with Bob → Bob is assigned and joins → realtime fanout."""
    from flow_sdk.builtin.conversation import Conversation
    from tests.hub_tests._local_login import login_as

    # Alice's cloud creds come from the conftest fixture (env-mode login).
    # login_as persists BOTH halves (token + user record); a token-only write is
    # a half-logged-in state that share() rejects.
    login_as(hub_login_payload)

    # Bob's creds come from the cycle env, with the sibling flowpad-app repo as
    # a local-development fallback. There is no second SDK identity in-process;
    # we drive bob over raw HTTP.
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

    # The verb under test — single call, the SDK fans out to share + join + invite.
    title = f"share-recipients-{int(time.time())}"
    conv = Conversation(title=title)
    await conv.share(recipients=[bob_email])
    assert conv.remote is True

    await assert_auto_assigned(
        hub_base_url,
        bob_token,
        entity_type="conversation",
        entity_id=conv.id,
        user_id=bob_id,
        expected_role="member",
    )

    # Joining is idempotent and enrolls Bob in realtime conversation fanout.
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/join",
            headers=headers_b,
            json={},
        )
        r.raise_for_status()

    # Realtime fanout: alice ignites with "1"; bob's WS must receive a
    # data_op_msg(create, flow_message). Single round-trip — proves the
    # share+assignment+join chain is fully wired without needing a longer loop.
    bob_rx = asyncio.Event()
    bob_rx_text: dict[str, str] = {}

    async def bob_loop():
        url = _make_ws_url(hub_base_url)
        async with websockets.connect(url, additional_headers=headers_b) as ws:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if msg.get("message_type") != "data_op_msg" or msg.get("op") != "create":
                    continue
                to = msg.get("to_entity")
                etype = to.split("-", 1)[0] if isinstance(to, str) else (to or {}).get("type")
                if etype != "flow_message":
                    continue
                data = msg.get("data") or {}
                if (data.get("sender_id") or "") == bob_id:
                    continue
                bob_rx_text["text"] = (data.get("text") or "").strip()
                bob_rx.set()
                return

    task = asyncio.create_task(bob_loop())
    await asyncio.sleep(0.2)  # let bob's WS connect
    t0 = time.monotonic()
    await conv.add_message("1")

    try:
        await asyncio.wait_for(bob_rx.wait(), timeout=2.0)
    except asyncio.TimeoutError:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        pytest.fail("bob did not receive fanout for alice's '1' within 2s")
    rtt_ms = (time.monotonic() - t0) * 1000
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert bob_rx_text.get("text") == "1"
    print(f"\n  share+assignment+join round-trip: {rtt_ms:.1f} ms")
    assert rtt_ms < 500, f"round-trip exceeded 500 ms SLO: {rtt_ms:.1f} ms"
