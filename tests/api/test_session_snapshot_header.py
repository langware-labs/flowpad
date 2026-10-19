"""The session snapshot fast path: a hub-origin session message carries the
session's wire snapshot in its carrier preview, and the receiver adopts it at
materialize time — before (and independent of) the body bundle."""
from __future__ import annotations

import json

import pytest

from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message
from flow_sdk.builtin.flow_message import AttachmentType
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus as S
from tests.api._session_helpers import make_conversation, make_session

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _event_payload(conv_id: str, sid: str, snapshot: dict, fm_id: str) -> dict:
    return {
        "id": fm_id,
        "text": "Alice approved the live session",
        "sender_id": "host-cloud-id",
        "sender_name": "Alice",
        "kind": "session_event",
        "remote_worker_session_id": sid,
        "attachment": [{
            "attachment_type": AttachmentType.TYPE_ID.value,
            "data": f"remote_worker_session-{sid}",
            "prompt_preview": json.dumps({"live_session_event": "approved", "snapshot": snapshot}),
        }],
    }


async def test_guest_adopts_status_from_the_header_snapshot(bootstrapped_client, user):
    conv_id = await make_conversation(bootstrapped_client)
    guest_row = await make_session(conv_id, S.PENDING.value, host_user_id="host-cloud-id",
                                   guest_user_id="me", last_activity_at="2026-09-06T10:00:00+00:00")
    snap = {**guest_row.snapshot(), "status": "idle", "approved_via": "manual",
            "reply_policy": "review", "last_activity_at": "2026-09-06T10:00:05+00:00"}
    fm = await materialize_flow_message(
        _event_payload(conv_id, guest_row.id, snap, "e1e1e1e1-0000-4000-8000-0000000000a1"),
        conv_id, someone_typeid=str(user.typeid), notify=False, remote=True,
    )
    assert fm.kind == "session_event"
    after = await RemoteWorkerSession.get_one({"id": guest_row.id})
    assert after.status == S.IDLE.value
    assert after.approved_via == "manual" and after.reply_policy == "review"


async def test_stale_header_snapshot_never_regresses(bootstrapped_client, user):
    conv_id = await make_conversation(bootstrapped_client)
    row = await make_session(conv_id, S.IDLE.value, host_user_id="host-cloud-id",
                             last_activity_at="2026-09-06T10:00:10+00:00")
    snap = {**row.snapshot(), "status": "pending", "last_activity_at": "2026-09-06T10:00:00+00:00"}
    await materialize_flow_message(
        _event_payload(conv_id, row.id, snap, "e1e1e1e1-0000-4000-8000-0000000000a2"),
        conv_id, someone_typeid=str(user.typeid), notify=False, remote=True,
    )
    assert (await RemoteWorkerSession.get_one({"id": row.id})).status == S.IDLE.value


async def test_unknown_session_materializes_from_the_header(bootstrapped_client, user):
    conv_id = await make_conversation(bootstrapped_client)
    sid = "e1e1e1e1-0000-4000-8000-0000000000b0"
    snap = {"id": sid, "type": "remote_worker_session", "conversation_id": conv_id, "status": "idle",
            "host_user_id": "host-cloud-id", "guest_user_id": "me", "starting_message_id": "fm-start",
            "last_activity_at": "2026-09-06T10:00:00+00:00"}
    await materialize_flow_message(
        _event_payload(conv_id, sid, snap, "e1e1e1e1-0000-4000-8000-0000000000b1"),
        conv_id, someone_typeid=str(user.typeid), notify=False, remote=True,
    )
    row = await RemoteWorkerSession.get_one({"id": sid})
    assert row is not None and row.status == S.IDLE.value and row.starting_message_id == "fm-start"


async def test_sent_session_message_carries_the_snapshot(bootstrapped_client, user):
    """The send side stamps the snapshot next to whatever marker is there."""
    from flow_sdk.builtin.flow_message import FlowMessage, session_snapshot_from_header, session_start_settings

    client = bootstrapped_client
    conv_id = await make_conversation(client)
    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"message": "", "prompt_text": "open a session", "is_draft": True, "reply_policy": "review"},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    fm = await FlowMessage.get_one({"id": resp.json()["data"]["flow_message_id"]})
    snap = session_snapshot_from_header(fm)
    assert snap and snap["id"] == fm.remote_worker_session_id and snap["starting_message_id"] == fm.id
    assert session_start_settings(fm).reply_policy == "review"  # start marker survived the merge
    assert "host_process_id" not in snap and "project_id" not in snap
