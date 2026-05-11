"""Conversation lifecycle round-trip against a live local hub.

test_share_in_cloud:
    conv = Conversation(title=...)
    await conv.share()
    assert conv.remote is True
    GET hub /graph/conversation/<id>   →   SUCCESS, data.id == conv.id, data.title == title

test_echo_round_trip_10:
    conv = Conversation(title=...); await conv.share()
    bring up the hub WS bridge (used by conv.add_message)
    for i in range(10):
        await conv.add_message(f"m{i}", echo=True)      # via WS rest_api_msg
        poll hub /graph/conversation/<id>/flow_message  # echo lives on hub
        verify "Received: m{i}" was created
    print per-message phase timings

    Notes:
      * Hub fanout (``Conversation._fanout_message``) iterates
        ``self.participants`` and skips the sender. A conversation created
        via the generic ``POST /graph/conversation`` ships with empty
        participants (the field is an ``EntityField`` the body doesn't
        populate), so the hub never WS-notifies us about the echo reply.
        That's why this test validates via REST GET instead of cloud_watch.
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


