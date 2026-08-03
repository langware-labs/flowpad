"""The message catch-up must ANNOUNCE the pointer it writes — live hub.

The reported bug: a message that arrives while the recipient is signed out
lands in SQLite on login but never reaches the open conversation view. Only a
manual Refresh surfaces it.

Root cause (proven both directions this session): a new hub message is written
by ``_process_single_hub_message``, whose pointer append calls
``project_pointers_to_entity(rec, notify=False)``
(flow_message_action.py:1814) — a SILENT write. The authoritative reconcile
that follows calls the same writer with ``notify=True``
(flow_message_action.py:2909), but ``project_pointers_to_entity`` returns early
when neither the projection nor the recency changed — and the silent write
already moved ``message_ids``, ``message_count`` AND ``conv.updated_date``. So
the silent write swallows the announcement: the row reaches the database and no
entity event is ever emitted.

Entry point: ``_fetch_conversation_messages`` — the seam that contains BOTH
steps, and the one the real login path reaches via
``start_hub_catchup`` → ``handle_conversation_list`` →
``_dispatch_conversation_message_fetches``. Testing either step alone would
miss the interaction, which IS the bug.

Observation is via ``on_tag`` — the product's own event-bus subscription API,
fed from ``DBEntity.add_entity_op_notification``, the single funnel every
entity notification (including the UI's ``data_op_msg``) flows through. A real
subscriber, not a spy: nothing is mocked, stubbed or replaced anywhere.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]


async def _hub_create_conversation(hub_base_url: str, api_key: str, *, title: str) -> str:
    """Create a hub Conversation the caller participates in."""
    from flow_sdk.builtin.conversation import Conversation

    conv = Conversation(title=title)
    await conv.share()
    async with httpx.AsyncClient(timeout=5.0) as h:
        await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/join",
            headers={"Authorization": f"Bearer {api_key}"},
            json={},
        )
    return conv.id  # type: ignore[return-value]


async def _hub_add_message(hub_base_url: str, api_key: str, conv_id: str, text: str) -> str:
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/add_message",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"text": text},
        )
    assert r.status_code == 200, r.text
    return (r.json().get("data") or {})["id"]


async def _hub_conversation(hub_base_url: str, api_key: str, conv_id: str) -> dict:
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}",
            headers={"Authorization": f"Bearer {api_key}"},
        )
    assert r.status_code == 200, r.text
    return (r.json() or {}).get("data") or {}


async def test_catchup_announces_the_message_pointer_it_writes(hub_base_url, hub_login_payload):
    """Syncing a new hub message must emit a conversation entity event.

    Without it the pointer list the conversation view renders from changes in
    SQLite with nobody listening, so an already-open view keeps drawing the
    previous message set until the user hits Refresh.
    """
    from flow_sdk.app.actions.flow_message_action import (
        _fetch_conversation_messages,
        _upsert_hub_conversation_metadata,
    )
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user
    from flow_sdk.tags import on_tag
    from tests.hub_tests._local_login import login_as

    api_key = login_as(hub_login_payload)
    someone = (await get_or_create_local_user()).typeid

    # ── the conversation already exists locally, with its first message ──
    # (the state a user is in when they have the thread open)
    conv_id = await _hub_create_conversation(hub_base_url, api_key, title=f"announce-{uuid.uuid4()}")
    await _hub_add_message(hub_base_url, api_key, conv_id, "first message")
    await _upsert_hub_conversation_metadata(
        await _hub_conversation(hub_base_url, api_key, conv_id),
        someone,
    )
    await _fetch_conversation_messages(conv_id, someone)
    local_conv = await Conversation.get_one({"id": conv_id})
    assert local_conv is not None, "precondition: conversation must be local"
    baseline_count = int(local_conv.message_count or 0)

    # ── a NEW message lands on the hub while we are away ──
    new_fm_id = await _hub_add_message(
        hub_base_url,
        api_key,
        conv_id,
        "arrived while the recipient was signed out",
    )

    # ── subscribe as a real bus consumer, then run the catch-up ──
    announced: list[str] = []

    def _record(event) -> None:
        if (event.data or {}).get("id") == conv_id:
            announced.append(event.tag)

    unsubscribe = on_tag("entity.*", _record)
    try:
        await _fetch_conversation_messages(conv_id, someone)
    finally:
        unsubscribe()

    # The write really happened — this is what makes the missing announcement
    # the defect, rather than "the sync fetched nothing".
    assert await FlowMessage.get_one({"id": new_fm_id}) is not None, (
        "precondition: the catch-up should have written the new message locally"
    )
    updated_conv = await Conversation.get_one({"id": conv_id})
    assert new_fm_id in (updated_conv.message_ids or ""), (
        "precondition: the new pointer should be in the conversation projection"
    )
    assert int(updated_conv.message_count or 0) == baseline_count + 1

    # ...and the announcement that the open view depends on.
    assert announced, (
        f"catch-up wrote the pointer for {new_fm_id[:8]} (message_count "
        f"{baseline_count} -> {updated_conv.message_count}) but emitted NO "
        "conversation entity event — an already-open conversation view is "
        "never told, so it keeps rendering the previous message set until the "
        "user clicks Refresh"
    )
