"""Live-session lifecycle + host gate (Phase 2).

Covers, against the real DB (no worker — the run seam is patched where a turn
would start):
  * guest-minted session-id ADOPTION in ``_reuse_or_bind_session``;
  * the HTTP lifecycle actions (approve/decline/pause/resume/disconnect):
    FSM-validated transitions, illegal moves rejected, and the SESSION_EVENT
    system line (with the snapshot-carrier attachment + event marker) landing
    in the bound conversation;
  * the inbound gate ``process_inbound_message``: PAUSED bounces (marks the
    prompt handled + emits the bounce line), terminal states ignore, and a
    PENDING/unknown session without a standing grant parks the session at
    PENDING and surfaces an approval card instead of running;
  * ``redrive_session_prompts`` selection (queued, un-handled, other-sender
    prompts of THIS session, in arrival order).
"""
from __future__ import annotations

import json

import pytest

from flow_sdk.app.actions import execute_prompt as ep
from flow_sdk.builtin.flow_message import (
    Attachment,
    AttachmentType,
    FlowMessage,
    FlowMessageKind,
)
from flow_sdk.builtin.remote_worker_session import (
    RemoteWorkerSession,
    RemoteWorkerSessionStatus as S,
)

pytestmark = pytest.mark.asyncio

GUEST_SESSION_ID = "b2b2b2b2-0000-4000-8000-0000000000a1"


async def _local_project_id(client) -> str:
    projects = (await client.get("/api/v1/graph/project")).json()["data"]
    return next(p for p in projects if p.get("uname") == "local")["id"]


async def _make_conversation(client) -> str:
    project_id = await _local_project_id(client)
    resp = await client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    return resp.json()["data"]["conversation_id"]


async def _session_messages(conv_id: str, *, kind: str | None = None) -> list[FlowMessage]:
    fms = await FlowMessage.get_all({"conversation_id": conv_id})
    out = [m for m in fms if getattr(m, "remote_worker_session_id", None)]
    if kind is not None:
        out = [m for m in out if m.kind == kind]
    return out


def _event_marker(fm: FlowMessage) -> str | None:
    for a in fm.attachment or []:
        if a.attachment_type == AttachmentType.TYPE_ID and (a.data or "").startswith("remote_worker_session-"):
            try:
                return (json.loads(a.prompt_preview or "") or {}).get("live_session_event")
            except (ValueError, TypeError):
                return None
    return None


async def _make_session(conv_id: str, status: str, session_id: str | None = None) -> RemoteWorkerSession:
    rws = RemoteWorkerSession(
        conversation_id=conv_id,
        host_user_id="host-local",
        guest_user_id="guest-remote",
        host_name="Alice",
        guest_name="Bob",
        status=status,
    )
    if session_id:
        rws.id = session_id
    await rws.save(notify=False)
    return rws


def _inbound_prompt_fm(conv_id: str, session_id: str | None, *, fm_id: str,
                       sender_id: str = "guest-remote") -> FlowMessage:
    atts = [Attachment(attachment_type=AttachmentType.PROMPT, data="run the tests")]
    if session_id:
        atts.append(Attachment(
            attachment_type=AttachmentType.TYPE_ID,
            data=f"remote_worker_session-{session_id}",
        ))
    fm = FlowMessage(
        text="please run this",
        sender_id=sender_id,
        sender_name="Bob",
        conversation_id=conv_id,
        remote_worker_session_id=session_id,
        attachment=atts,
    )
    fm.id = fm_id
    return fm


# ── adoption ─────────────────────────────────────────────────────────────────

@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_bind_session_adopts_guest_minted_id(bootstrapped_client, user):
    rws = await ep._reuse_or_bind_session(
        conversation_id="conv-adopt-1", host_user_id="host1", guest_user_id="guest1",
        host_process_id="ap1", project_id="proj1", status=S.RUNNING,
        session_id=GUEST_SESSION_ID,
    )
    assert rws.id == GUEST_SESSION_ID
    assert rws.status == S.RUNNING

    # Second bind with the same id reuses the SAME row (host refresh).
    again = await ep._reuse_or_bind_session(
        conversation_id="conv-adopt-1", host_user_id="host1", guest_user_id="guest1",
        host_process_id="ap2", project_id="proj1", status=S.IDLE,
        session_id=GUEST_SESSION_ID,
    )
    assert again.id == GUEST_SESSION_ID
    assert again.host_process_id == "ap2"
    assert again.status == S.IDLE
    await again.delete()


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_bind_session_rejects_invalid_foreign_id(bootstrapped_client, user):
    """A non-v4/v5 id (e.g. a hand-authored v7) must NOT become the session id —
    entity-id policy: validate on adopt, fall back to a minted row."""
    v7ish = "01890000-0000-7000-8000-000000000001"
    rws = await ep._reuse_or_bind_session(
        conversation_id="conv-adopt-2", host_user_id="host1", guest_user_id="guest1",
        host_process_id="ap1", project_id="proj1", status=S.RUNNING,
        session_id=v7ish,
    )
    assert rws.id != v7ish
    await rws.delete()


# ── HTTP lifecycle actions ───────────────────────────────────────────────────

@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_lifecycle_actions_transition_and_announce(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    rws = await _make_session(conv_id, S.PENDING.value)

    # approve: PENDING → IDLE + "approved" system line with carrier marker.
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={})
    assert resp.json().get("status") == "SUCCESS", resp.text
    assert resp.json()["data"]["status"] == S.IDLE.value
    events = await _session_messages(conv_id, kind=FlowMessageKind.SESSION_EVENT.value)
    assert any(_event_marker(m) == "approved" for m in events)
    approved_line = next(m for m in events if _event_marker(m) == "approved")
    assert approved_line.remote_worker_session_id == rws.id
    assert "approved the live session" in approved_line.text

    # decline is a PENDING verb — illegal from IDLE.
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/decline", json={})
    assert resp.json().get("status") != "SUCCESS"

    # pause → PAUSED, resume → IDLE.
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/pause", json={})
    assert resp.json()["data"]["status"] == S.PAUSED.value
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/resume", json={})
    assert resp.json()["data"]["status"] == S.IDLE.value

    # disconnect → ENDED (+ "ended" line); approve afterwards is illegal.
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/disconnect", json={})
    assert resp.json()["data"]["status"] == S.ENDED.value
    events = await _session_messages(conv_id, kind=FlowMessageKind.SESSION_EVENT.value)
    markers = {_event_marker(m) for m in events}
    assert {"approved", "paused", "resumed", "ended"} <= markers
    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={})
    assert resp.json().get("status") != "SUCCESS"


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_decline_is_terminal(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    rws = await _make_session(conv_id, S.PENDING.value)

    resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/decline", json={})
    assert resp.json().get("status") == "SUCCESS", resp.text
    assert resp.json()["data"]["status"] == S.DECLINED.value
    events = await _session_messages(conv_id, kind=FlowMessageKind.SESSION_EVENT.value)
    assert any(_event_marker(m) == "declined" for m in events)

    for verb in ("approve", "pause", "resume"):
        resp = await client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/{verb}", json={})
        assert resp.json().get("status") != "SUCCESS", verb


# ── inbound gate ─────────────────────────────────────────────────────────────

@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_gate_paused_session_bounces(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    rws = await _make_session(conv_id, S.PAUSED.value)
    fm = _inbound_prompt_fm(conv_id, rws.id, fm_id="b2b2b2b2-0000-4000-8000-0000000000b1")
    await fm.save(notify=False)

    await ep.process_inbound_message(fm.id, conv_id)

    after = await FlowMessage.get_one({"id": fm.id})
    assert after.prompt_auto_handled is True  # never re-bounces on re-sync
    events = await _session_messages(conv_id, kind=FlowMessageKind.SESSION_EVENT.value)
    assert any(_event_marker(m) == "prompt_bounced" for m in events)


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_gate_terminal_session_ignores(bootstrapped_client, user, monkeypatch):
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    ran = []
    monkeypatch.setattr(ep, "execute_prompt_from_message",
                        lambda *a, **k: ran.append(1))
    for i, status in enumerate((S.ENDED.value, S.DECLINED.value)):
        rws = await _make_session(conv_id, status)
        fm = _inbound_prompt_fm(conv_id, rws.id, fm_id=f"b2b2b2b2-0000-4000-8000-0000000000c{i}")
        await fm.save(notify=False)
        await ep.process_inbound_message(fm.id, conv_id)
        after = await FlowMessage.get_one({"id": fm.id})
        assert after.prompt_auto_handled is False  # untouched — nothing ran
    assert ran == []


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_gate_unknown_session_without_grant_parks_pending(bootstrapped_client, user, monkeypatch):
    """No standing ContactPermission grant: the guest-minted session id is
    adopted at PENDING, an approval card is surfaced (once — deduped), the
    prompt stays un-handled for the approve re-drive, and nothing runs."""
    from flow_sdk.builtin.message_suggest import MessageSuggest

    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    ran = []
    monkeypatch.setattr(ep, "execute_prompt_from_message",
                        lambda *a, **k: ran.append(1))
    sid = "b2b2b2b2-0000-4000-8000-0000000000d1"
    fm = _inbound_prompt_fm(conv_id, sid, fm_id="b2b2b2b2-0000-4000-8000-0000000000d2")
    await fm.save(notify=False)

    await ep.process_inbound_message(fm.id, conv_id)
    await ep.process_inbound_message(fm.id, conv_id)  # re-delivery → no dup card

    assert ran == []
    session = await RemoteWorkerSession.get_one({"id": sid})
    assert session is not None
    assert session.status == S.PENDING.value
    assert session.guest_user_id == "guest-remote"
    after = await FlowMessage.get_one({"id": fm.id})
    assert after.prompt_auto_handled is False  # approve re-drives it later
    cards = [s for s in await MessageSuggest.get_all({"flow_message_id": fm.id})
             if getattr(s, "kind", None) == "live_session_approval"]
    assert len(cards) == 1


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_gate_active_session_runs_with_auto_reply(bootstrapped_client, user, monkeypatch):
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    rws = await _make_session(conv_id, S.IDLE.value)
    fm = _inbound_prompt_fm(conv_id, rws.id, fm_id="b2b2b2b2-0000-4000-8000-0000000000e1")
    await fm.save(notify=False)

    calls = []
    async def fake_run(fm_arg, conv_arg, *, auto_reply, approver_id, someone_typeid):
        calls.append({"fm": fm_arg.id, "auto_reply": auto_reply})
    monkeypatch.setattr(ep, "execute_prompt_from_message", fake_run)

    await ep.process_inbound_message(fm.id, conv_id)
    assert calls == [{"fm": fm.id, "auto_reply": True}]  # live implies auto-reply


# ── redrive ──────────────────────────────────────────────────────────────────

@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_redrive_selects_queued_session_prompts_in_order(bootstrapped_client, user, monkeypatch):
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    rws = await _make_session(conv_id, S.IDLE.value)

    queued1 = _inbound_prompt_fm(conv_id, rws.id, fm_id="b2b2b2b2-0000-4000-8000-0000000000f1")
    await queued1.save(notify=False)
    queued2 = _inbound_prompt_fm(conv_id, rws.id, fm_id="b2b2b2b2-0000-4000-8000-0000000000f2")
    await queued2.save(notify=False)
    handled = _inbound_prompt_fm(conv_id, rws.id, fm_id="b2b2b2b2-0000-4000-8000-0000000000f3")
    handled.prompt_auto_handled = True
    await handled.save(notify=False)
    other_session = _inbound_prompt_fm(conv_id, "b2b2b2b2-0000-4000-8000-0000000000f9",
                                       fm_id="b2b2b2b2-0000-4000-8000-0000000000f4")
    await other_session.save(notify=False)

    ran: list[str] = []
    async def fake_run(fm_arg, conv_arg, *, auto_reply, approver_id, someone_typeid):
        assert auto_reply is True
        ran.append(fm_arg.id)
        return None
    monkeypatch.setattr(ep, "execute_prompt_from_message", fake_run)

    await ep.redrive_session_prompts(rws)
    assert ran == [queued1.id, queued2.id]
