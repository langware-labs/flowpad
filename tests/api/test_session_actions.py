"""RemoteWorkerSession HTTP lifecycle: approve (+remember), decline, pause,
resume, disconnect, settings — FSM-validated, announced with SESSION_EVENT
lines carrying the snapshot; approve re-drives queued turns in order."""
from __future__ import annotations

import asyncio

import pytest

from flow_sdk.app.actions import execute_prompt as ep
from flow_sdk.builtin.contact_permission import ContactPermission, PermissionAction
from flow_sdk.builtin.flow_message import FlowMessageKind
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus as S
from tests.api._session_helpers import (
    event_marker,
    inbound_prompt_fm,
    make_conversation,
    make_session,
    session_messages,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

PROJ = "e5e5e5e5-0000-4000-8000-0000000000aa"


async def test_lifecycle_actions_transition_and_announce(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await make_conversation(client)
    rws = await make_session(conv_id, S.PENDING.value)

    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={})
    assert resp.json().get("status") == "SUCCESS", resp.text
    assert resp.json()["data"]["status"] == S.IDLE.value
    assert resp.json()["data"]["approved_via"] == "manual"
    assert resp.json()["data"]["approved_at"]
    events = await session_messages(conv_id, kind=FlowMessageKind.SESSION_EVENT.value)
    approved_line = next(m for m in events if event_marker(m) == "approved")
    assert approved_line.remote_worker_session_id == rws.id
    assert "approved the live session" in approved_line.text

    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/decline", json={})
    assert resp.json().get("status") != "SUCCESS"

    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/pause", json={})
    assert resp.json()["data"]["status"] == S.PAUSED.value
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/resume", json={})
    assert resp.json()["data"]["status"] == S.IDLE.value

    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/disconnect", json={})
    assert resp.json()["data"]["status"] == S.ENDED.value
    events = await session_messages(conv_id, kind=FlowMessageKind.SESSION_EVENT.value)
    assert {"approved", "paused", "resumed", "ended"} <= {event_marker(m) for m in events}
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={})
    assert resp.json().get("status") != "SUCCESS"


async def test_decline_is_terminal(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await make_conversation(client)
    rws = await make_session(conv_id, S.PENDING.value)
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/decline", json={})
    assert resp.json()["data"]["status"] == S.DECLINED.value
    events = await session_messages(conv_id, kind=FlowMessageKind.SESSION_EVENT.value)
    assert any(event_marker(m) == "declined" for m in events)
    for verb in ("approve", "pause", "resume"):
        resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/{verb}", json={})
        assert resp.json().get("status") != "SUCCESS", verb


@pytest.mark.parametrize("remember,expected_project", [("project", PROJ), ("everywhere", None)])
async def test_approve_with_remember_writes_the_standing_grant(bootstrapped_client, user, remember, expected_project):
    client = bootstrapped_client
    conv_id = await make_conversation(client)
    rws = await make_session(conv_id, S.PENDING.value, guest_user_id=f"guest-{remember}", project_id=PROJ)
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={"remember": remember})
    assert resp.json().get("status") == "SUCCESS", resp.text
    rows = await ContactPermission.get_all({"contact_user_id": f"guest-{remember}"})
    try:
        assert len(rows) == 1
        assert rows[0].project_id == expected_project
        assert rows[0].allowed_actions == [PermissionAction.AUTO_APPROVE_SESSION.value]
        # approving again with the same scope does not duplicate the row
        rws2 = await make_session(conv_id, S.PENDING.value, guest_user_id=f"guest-{remember}", project_id=PROJ)
        await client.post(f"/api/v1/graph/remote_worker_session/{rws2.id}/approve", json={"remember": remember})
        assert len(await ContactPermission.get_all({"contact_user_id": f"guest-{remember}"})) == 1
    finally:
        for r in await ContactPermission.get_all({"contact_user_id": f"guest-{remember}"}):
            await r.delete()


async def test_approve_rejects_a_bad_remember_scope(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await make_conversation(client)
    rws = await make_session(conv_id, S.PENDING.value)
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={"remember": "forever"})
    assert resp.json().get("status") != "SUCCESS"
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status == S.PENDING.value


async def test_settings_persists_reply_policy_and_announces(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await make_conversation(client)
    rws = await make_session(conv_id, S.IDLE.value)
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/settings", json={"reply_policy": "review"})
    assert resp.json().get("status") == "SUCCESS", resp.text
    assert resp.json()["data"]["reply_policy"] == "review"
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).reply_policy == "review"
    events = await session_messages(conv_id, kind=FlowMessageKind.SESSION_EVENT.value)
    assert any(event_marker(m) == "settings_changed" for m in events)

    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/settings", json={"reply_policy": "loud"})
    assert resp.json().get("status") != "SUCCESS"
    await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/disconnect", json={})
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/settings", json={"reply_policy": "auto"})
    assert resp.json().get("status") != "SUCCESS"


async def test_approve_redrives_queued_turns_in_order(bootstrapped_client, user, monkeypatch):
    client = bootstrapped_client
    conv_id = await make_conversation(client)
    rws = await make_session(conv_id, S.PENDING.value)
    q1 = inbound_prompt_fm(conv_id, rws.id, fm_id="b2b2b2b2-0000-4000-8000-0000000000f1")
    await q1.save(notify=False)
    q2 = inbound_prompt_fm(conv_id, rws.id, fm_id="b2b2b2b2-0000-4000-8000-0000000000f2")
    await q2.save(notify=False)
    consumed = inbound_prompt_fm(conv_id, rws.id, fm_id="b2b2b2b2-0000-4000-8000-0000000000f3")
    consumed.prompt_auto_handled = True
    await consumed.save(notify=False)
    other = inbound_prompt_fm(conv_id, "b2b2b2b2-0000-4000-8000-0000000000f9", fm_id="b2b2b2b2-0000-4000-8000-0000000000f4")
    await other.save(notify=False)

    ran: list[str] = []
    done = asyncio.Event()

    async def fake_run(session, fm, conv, *, someone_typeid, **_kw):
        ran.append(fm.id)
        fm.prompt_auto_handled = True  # the runner's contract: consume before returning
        await fm.save(someone_typeid)
        if len(ran) == 2:
            done.set()

    monkeypatch.setattr(ep, "run_session_turn", fake_run)
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={})
    assert resp.json().get("status") == "SUCCESS", resp.text
    await asyncio.wait_for(done.wait(), timeout=5)  # do not increase timeout without approval
    assert ran == [q1.id, q2.id]
