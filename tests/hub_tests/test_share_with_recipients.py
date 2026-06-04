"""``Conversation.share(recipients=[...])`` end-to-end via the SDK method.

Verifies that the SDK helper produces the same hub-side state as the
hand-rolled HTTP sequence in ``test_two_client_loop.py``:

  - hub-side Conversation exists
  - alice is in ``participants`` (via the join the SDK fires after share)
  - one ``Invitation`` row exists for bob's email
  - bob can accept and join through the standard ``/members/accept``
    + ``/conversation/<id>/join`` pair
  - both ends receive ``flow_message`` fanout (alice ignites "1", bob rxs)

This is the canonical SDK-driven test for the share+invite+accept+join
pattern. ``test_two_client_loop.py`` covers the raw HTTP version; this one
covers the same flow through the Python SDK that the UI / TS SDK also build
on top of.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
import websockets


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
    """Alice uses ``Conversation.share(recipients=[bob_email])`` → bob accepts → realtime fanout."""
    from flow_sdk.cli.auth.credentials import UserHubCredentials, save_credentials
    from flow_sdk.builtin.conversation import Conversation

    # Alice's cloud creds come from the conftest fixture (env-mode login).
    alice_token = hub_login_payload.get("api_key") or hub_login_payload["token"]
    alice_user = hub_login_payload.get("user") or {}
    save_credentials(UserHubCredentials(api_key=alice_token, user=alice_user))
    alice_id = alice_user["id"]

    # Bob's creds come from the sibling flowpad-app repo's .env.local — there's
    # no second SDK identity in-process; we drive bob over raw HTTP.
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

    headers_b = {"Authorization": f"Bearer {bob_token}", "Content-Type": "application/json"}

    # The verb under test — single call, the SDK fans out to share + join + invite.
    title = f"share-recipients-{int(time.time())}"
    conv = Conversation(title=title)
    await conv.share(recipients=[bob_email])
    assert conv.remote is True

    # Bob discovers the invitation via the canonical ``/invitation/pending``.
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/invitation/pending", headers=headers_b)
        r.raise_for_status()
        pending = r.json()["data"] or []
        matching = [inv for inv in pending if inv.get("recipient_email") == bob_email and not inv.get("accepted")]
        assert matching, f"bob has no pending invitation; got {pending}"
        matching.sort(key=lambda x: x.get("created_date") or "", reverse=True)
        invitation_id = matching[0]["id"]

        # Bob accepts → grants role on the Conversation target.
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/members/accept",
            headers=headers_b,
            params={"invitation-id": invitation_id},
        )
        r.raise_for_status()

        # Bob joins → enters ``participants``.
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/join",
            headers=headers_b,
            json={},
        )
        r.raise_for_status()

    # Realtime fanout: alice ignites with "1"; bob's WS must receive a
    # data_op_msg(create, flow_message). Single round-trip — proves the
    # share+invite+accept+join chain is fully wired without needing a longer loop.
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
    print(f"\n  share+invite+accept+join round-trip: {rtt_ms:.1f} ms")
    assert rtt_ms < 500, f"round-trip exceeded 500 ms SLO: {rtt_ms:.1f} ms"
