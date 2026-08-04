"""Sending the same text twice on purpose must stay TWO messages.

The duplicate-send fix recovers a message the hub committed but never confirmed,
and it identifies that message by (conversation, text, sender, created-after).
Text is not an identity: send "1" twice — which is exactly what a person does
while testing, and what produced the reported duplicates — and a careless probe
can hand the second send the FIRST send's row, reporting success for a message
it never wrote. The user typed twice and sees once.

That direction is worse than the bug being fixed: a duplicate is visible and
annoying, a swallowed message is silent data loss. So this pins the opposite
guarantee from ``test_add_message_ambiguous_send_no_duplicate``: identical text
sent twice, uninterrupted, must produce two distinct hub rows.
"""

from __future__ import annotations

import uuid

import httpx
import pytest


async def _hub_rows_with_text(hub_base_url: str, api_key: str, conv_id: str, text: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=15.0) as h:
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/flow_message",
            headers={"Authorization": f"Bearer {api_key}"},
        )
    r.raise_for_status()
    return [m for m in (r.json().get("data") or []) if (m.get("text") or "").strip() == text]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(60)
async def test_same_text_sent_twice_stays_two_messages(hub_base_url, hub_login_payload, isolated_hub_keyring):
    """Two deliberate sends of identical text must not collapse into one."""
    from flow_sdk.app.actions.notification_action import handle_add_message
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.cloud_client.ws_client import hub_ws_manager
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user
    from tests.hub_tests._local_login import login_as

    api_key = login_as(hub_login_payload)
    someone = (await get_or_create_local_user()).typeid

    conv = Conversation(title=f"repeat-{uuid.uuid4().hex[:8]}")
    await conv.share(recipients=[])
    await conv.save(someone)
    assert await Conversation.get_one({"id": conv.id}) is not None, "precondition: conversation must be local"

    status = await hub_ws_manager.restart(wait_connected=True)
    assert status.get("hub_ws_connected") is True, f"precondition: hub WS must be up, got {status}"

    text = "1"  # the shortest, most repeatable thing a person actually types

    try:
        first = await handle_add_message({"conversation_id": conv.id, "text": text}, someone)
        second = await handle_add_message({"conversation_id": conv.id, "text": text}, someone)
    finally:
        # Leave the manager stopped. Its reader/writer tasks are bound to THIS
        # test's event loop; handing them to the next test makes that test die
        # with "Event loop is closed" — an order-dependent failure that has
        # nothing to do with what it asserts.
        await hub_ws_manager.stop()
    assert first.status == "SUCCESS", first
    assert second.status == "SUCCESS", second

    rows = await _hub_rows_with_text(hub_base_url, api_key, conv.id, text)
    ids = sorted({m.get("id") for m in rows})
    assert len(ids) == 2, (
        f"two deliberate sends of {text!r} produced {len(ids)} hub row(s) (ids={[i[:8] for i in ids]}). "
        "The recovery probe matches on text, so it must never hand one send another send's message — "
        "that silently swallows a message the user actually typed."
    )

    # And the two responses must point at DIFFERENT rows: a single row reported
    # twice is the same loss wearing a passing test as a disguise.
    first_id = (first.data or {}).get("id") or (first.data or {}).get("flow_message_id")
    second_id = (second.data or {}).get("id") or (second.data or {}).get("flow_message_id")
    assert first_id and second_id and first_id != second_id, (
        f"both sends returned the same message id ({str(first_id)[:8]}) — the second send adopted the "
        "first send's row instead of writing its own"
    )
