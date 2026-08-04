"""One send must never produce two hub rows, even when the send's outcome is unknown.

The reported bug: a message the user typed once appeared twice on both sides.
Root cause proven this session — ``handle_add_message`` takes the text-only WS
fast path, and ``_try_send_reply_via_hub`` returns ``None`` for BOTH "the send
failed" and "the send may have landed but we never saw the reply". The caller
treats ``None`` as definitely-failed and falls through to
``_build_reply_flow_message``, minting a SECOND message over HTTP — while the
hub had already committed the first (its ExecutionContext uses
``immediate_commit=True``, so the row survives the connection dying).

Observed in production logs four times, via two different triggers:
  * ``received 1011 (internal error)`` — the hub closed the socket after
    committing (16:23:30, 16:31:44, 16:46:25)
  * a blank reason, i.e. ``str(asyncio.TimeoutError())`` — the 10s
    ``send_request`` budget elapsed with the row already written (16:36:44)

Both reduce to the same thing, which is what this test reproduces: the frame
reached the hub and committed, and the client did not get the reply.

The ambiguity is produced FOR REAL, not simulated: the request goes out over
the live hub WebSocket and the connection is then genuinely dropped mid-flight
(``hub_ws_manager.stop()``), which is the same event the hub's 1011 close
caused. Nothing is mocked or monkeypatched — the hub really commits, and the
client really loses the reply.

Ground truth is the HUB's own row count for the message text, not any local
projection: the duplicate is a hub-side fact, and local state merely mirrors it.
"""

from __future__ import annotations

import asyncio
import logging
import uuid

import httpx
import pytest


async def _hub_rows_with_text(hub_base_url: str, api_key: str, conv_id: str, text: str) -> list[dict]:
    """Every hub FlowMessage in this conversation carrying exactly ``text``."""
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
async def test_one_send_produces_one_hub_row_when_the_reply_is_lost(
    hub_base_url, hub_login_payload, isolated_hub_keyring, caplog
):
    """A single ``add_message`` whose WS reply never arrives must not re-send."""
    from flow_sdk.app.actions.notification_action import handle_add_message
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.cloud_client.ws_client import hub_ws_manager
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user
    from tests.hub_tests._local_login import login_as

    api_key = login_as(hub_login_payload)
    someone = (await get_or_create_local_user()).typeid

    # A real remote conversation — the WS fast path only runs for one.
    conv = Conversation(title=f"dup-send-{uuid.uuid4().hex[:8]}")
    await conv.share(recipients=[])
    assert conv.remote is True, "precondition: the conversation must be hub-backed"
    # ``share`` publishes to the hub; the action resolves the LOCAL row, so make
    # sure it is persisted (this is the state a real user's conversation is in).
    await conv.save(someone)
    assert await Conversation.get_one({"id": conv.id}) is not None, "precondition: conversation must be local"

    status = await hub_ws_manager.restart(wait_connected=True)
    assert status.get("hub_ws_connected") is True, f"precondition: hub WS must be up, got {status}"

    text = f"dup-probe-{uuid.uuid4().hex[:8]}"

    # Send once through the REAL action the UI calls, and drop the live
    # connection while the request is in flight. The frame is already with the
    # hub, so it commits; the reply is lost — exactly the state the 1011 close
    # and the 10s timeout both leave the client in.
    send = asyncio.create_task(handle_add_message({"conversation_id": conv.id, "text": text}, someone))
    # 60ms lands inside the ambiguous window, measured on this rig: below ~40ms
    # the frame has not left the client (nothing commits, no duplicate); above
    # ~100ms the reply has already been consumed (send succeeds). Between them
    # the hub has committed and the reply is lost — the state the 1011 close and
    # the 10s timeout both produce in production.
    with caplog.at_level(logging.WARNING, logger="flow_sdk.app.actions.notification_action"):
        await asyncio.sleep(0.06)
        await hub_ws_manager.stop()
        await send

        # Let any fallback finish writing before counting.
        await asyncio.sleep(2.0)

    # The window is timing-based, so the interruption might simply not have
    # happened — and then a green result would mean nothing, because the code
    # under test never ran. Require the ambiguity to have occurred, so a missed
    # window is a loud failure to retune rather than a silent false pass.
    assert any("hub add_message failed" in r.message for r in caplog.records), (
        "the send completed normally — the disconnect missed the ambiguous window, so this run "
        "did NOT exercise the bug. Retune the sleep above (measured window on the original rig: "
        "~40-100ms; below it the frame never leaves, above it the reply is already consumed)."
    )

    rows = await _hub_rows_with_text(hub_base_url, api_key, conv.id, text)
    assert len(rows) == 1, (
        f"one add_message produced {len(rows)} hub rows for {text!r} "
        f"(ids={[m.get('id', '')[:8] for m in rows]}). The WS send's outcome was "
        "unknown, not failed — the client re-sent a write the hub had already "
        "committed."
    )
