"""Conversation lifecycle round-trip against a live local hub.

test_share_in_cloud:
    conv = Conversation(title=...)
    await conv.share()
    assert conv.remote is True
    GET hub /graph/conversation/<id>   →   SUCCESS, data.id == conv.id, data.title == title

test_echo_round_trip_10:
    conv = Conversation(title=...); await conv.share()
    async with conv.cloud_watch() as stream:
        for i in range(10):
            await conv.add_message(f"m{i}", echo=True)
            echo = await stream.next_where(lambda ev: ev matches "Received: m{i}")
    prints per-message timings
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

import httpx
import pytest


@pytest.mark.asyncio
async def test_share_in_cloud(hub_base_url, hub_login_payload, isolated_hub_keyring):
    # Stash the JWT into the (monkey-patched) keyring slot the share() helper
    # reads from. The autouse `isolated_hub_keyring` fixture redirects the
    # keyring backend to an in-memory dict so this doesn't touch the macOS
    # keychain.
    from flow_sdk.cli.auth.credentials import UserHubCredentials, save_credentials
    from flow_sdk.builtin.conversation import Conversation

    api_key = hub_login_payload.get("api_key") or hub_login_payload["token"]
    save_credentials(
        UserHubCredentials(
            api_key=api_key,
            user=hub_login_payload.get("user") or {},
        )
    )

    # Standard entity construction. id is auto-allocated by the base Entity
    # default factory; we don't need save() because we're calling share()
    # directly against the hub (no local backend involved in this test).
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    title = f"basic-share-{ts}"
    conv = Conversation(title=title)
    assert conv.id, "Conversation should auto-allocate an id"
    assert conv.remote is False

    # The verb under test.
    await conv.share()

    # Local flag flipped.
    assert conv.remote is True

    # Hub fetched by the same id returns the same entity.
    url = f"{hub_base_url}/api/v1/graph/conversation/{conv.id}"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(url, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("status") == "SUCCESS", body
    data = body["data"]
    assert data["id"] == conv.id
    assert data.get("title") == title
    assert data.get("type") == "conversation"


@pytest.mark.asyncio
async def test_echo_round_trip_10(hub_base_url, hub_login_payload, isolated_hub_keyring):
    """End-to-end: share + 10 messages with echo=true; consume replies via
    ``cloud_watch`` and print per-message timings.

    Stages per iteration:
      send  — POST add_message via the hub WebSocket bridge
      echo  — hub's auto-reply ``"Received: m{i}"`` arrives via the bridge
              and fans out as a ``data_op_msg`` create
    """
    from flow_sdk.cli.auth.credentials import UserHubCredentials, save_credentials
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge
    from flow_sdk.cloud_client.ws_client import hub_ws_manager

    api_key = hub_login_payload.get("api_key") or hub_login_payload["token"]
    save_credentials(
        UserHubCredentials(
            api_key=api_key,
            user=hub_login_payload.get("user") or {},
        )
    )

    # Bring up the bridge: registers data_op_msg handler + opens a
    # persistent WS to the hub. Generic subscribers (cloud_watch) tap into
    # the same dispatcher.
    hub_ws_bridge.install()
    status = await hub_ws_manager.start(wait_connected=True)
    assert status.get("hub_ws_connected"), f"hub WS failed to connect: {status}"

    try:
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        conv = Conversation(title=f"echo-roundtrip-{ts}")
        await conv.share()
        assert conv.remote is True

        rows: list[tuple[int, float, float]] = []

        async with conv.cloud_watch() as stream:
            for i in range(10):
                expected = f"Received: m{i}"

                t0 = time.monotonic()
                await conv.add_message(f"m{i}", echo=True)
                t_sent = time.monotonic()

                ev = await stream.next_where(
                    lambda e, _t=expected: (
                        e.entity_type == "flow_message"
                        and e.op == "create"
                        and (e.data or {}).get("text") == _t
                    ),
                    timeout=3.0,
                )
                t_echo = time.monotonic()

                rows.append((i, (t_sent - t0) * 1000.0, (t_echo - t_sent) * 1000.0))
                assert ev.data.get("text") == expected
                assert (ev.data.get("sender_id") or "").startswith("echo-bot-")

        print()
        print(f"{'i':>2}  {'send_ms':>8}  {'echo_ms':>8}")
        for i, send_ms, echo_ms in rows:
            print(f"{i:>2}  {send_ms:>8.1f}  {echo_ms:>8.1f}")
        send_avg = sum(r[1] for r in rows) / len(rows)
        echo_avg = sum(r[2] for r in rows) / len(rows)
        print(f"        avg  send={send_avg:.1f}ms  echo={echo_avg:.1f}ms")

    finally:
        await hub_ws_manager.stop()
