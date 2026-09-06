"""The ONE inbound gate — ``process_inbound_prompt`` against the real DB.

The run seam (``run_session_turn``) is patched where a turn would start; the
session resolution, the consent decision and the marker discipline are real.
"""
from __future__ import annotations

import pytest

from flow_sdk.app.actions import execute_prompt as ep
from flow_sdk.builtin.contact_permission import ContactPermission, PermissionAction
from flow_sdk.builtin.flow_message import FlowMessage, FlowMessageKind
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


def _patch_run(monkeypatch):
    ran: list[tuple[str, str]] = []

    async def fake_run(session, fm, conv, *, someone_typeid, **_kw):
        ran.append((session.id, fm.id))
        fm.prompt_auto_handled = True
        await fm.save(someone_typeid)
        return None

    monkeypatch.setattr(ep, "run_session_turn", fake_run)
    return ran


async def test_paused_session_bounces(bootstrapped_client, user, monkeypatch):
    ran = _patch_run(monkeypatch)
    conv_id = await make_conversation(bootstrapped_client)
    rws = await make_session(conv_id, S.PAUSED.value)
    fm = inbound_prompt_fm(conv_id, rws.id, fm_id="b2b2b2b2-0000-4000-8000-0000000000b1")
    await fm.save(notify=False)

    await ep.process_inbound_prompt(fm.id, conv_id)

    assert ran == []
    after = await FlowMessage.get_one({"id": fm.id})
    assert after.prompt_auto_handled is True  # never re-bounces on re-sync
    events = await session_messages(conv_id, kind=FlowMessageKind.SESSION_EVENT.value)
    assert any(event_marker(m) == "prompt_bounced" for m in events)


async def test_terminal_session_ignores(bootstrapped_client, user, monkeypatch):
    ran = _patch_run(monkeypatch)
    conv_id = await make_conversation(bootstrapped_client)
    for i, status in enumerate((S.ENDED.value, S.DECLINED.value)):
        rws = await make_session(conv_id, status)
        fm = inbound_prompt_fm(conv_id, rws.id, fm_id=f"b2b2b2b2-0000-4000-8000-0000000000c{i}")
        await fm.save(notify=False)
        await ep.process_inbound_prompt(fm.id, conv_id)
        after = await FlowMessage.get_one({"id": fm.id})
        assert after.prompt_auto_handled is False
    assert ran == []


async def test_unknown_session_without_grant_parks_pending(bootstrapped_client, user, monkeypatch):
    """The guest-minted id is adopted at PENDING with the opening proposal,
    the prompt stays unconsumed for the approve re-drive, nothing runs, and a
    re-delivery is a no-op."""
    ran = _patch_run(monkeypatch)
    conv_id = await make_conversation(bootstrapped_client)
    sid = "b2b2b2b2-0000-4000-8000-0000000000d1"
    fm = inbound_prompt_fm(conv_id, sid, fm_id="b2b2b2b2-0000-4000-8000-0000000000d2",
                           start_marker={"reply_policy": "review"})
    await fm.save(notify=False)

    await ep.process_inbound_prompt(fm.id, conv_id)
    await ep.process_inbound_prompt(fm.id, conv_id)

    assert ran == []
    session = await RemoteWorkerSession.get_one({"id": sid})
    assert session is not None
    assert session.status == S.PENDING.value
    assert session.starting_message_id == fm.id
    assert session.reply_policy == "review"
    assert session.guest_user_id == "guest-remote"
    assert (await FlowMessage.get_one({"id": fm.id})).prompt_auto_handled is False
    assert len(await RemoteWorkerSession.get_all({"conversation_id": conv_id})) == 1


async def test_unstamped_prompt_mints_a_session_and_redelivery_finds_it(bootstrapped_client, user, monkeypatch):
    """A prompt with no session id (old client) still opens a session. The id
    is a fresh uuid4; a re-delivered copy finds the SAME row by its natural
    key (``starting_message_id``), never by id arithmetic."""
    from flow_sdk.api.api_types.identifier import is_valid_entity_id

    _patch_run(monkeypatch)
    conv_id = await make_conversation(bootstrapped_client)
    fm = inbound_prompt_fm(conv_id, None, fm_id="b2b2b2b2-0000-4000-8000-0000000000d3")
    await fm.save(notify=False)

    await ep.process_inbound_prompt(fm.id, conv_id)
    rows = await RemoteWorkerSession.get_all({"conversation_id": conv_id})
    assert len(rows) == 1 and rows[0].starting_message_id == fm.id
    assert is_valid_entity_id(rows[0].id)
    assert (await FlowMessage.get_one({"id": fm.id})).remote_worker_session_id == rows[0].id

    # simulate a re-delivered copy that lost its stamp
    fm2 = await FlowMessage.get_one({"id": fm.id})
    fm2.remote_worker_session_id = None
    await fm2.save(notify=False)
    await ep.process_inbound_prompt(fm.id, conv_id)
    rows = await RemoteWorkerSession.get_all({"conversation_id": conv_id})
    assert len(rows) == 1


async def test_invalid_foreign_id_is_replaced(bootstrapped_client, user, monkeypatch):
    _patch_run(monkeypatch)
    conv_id = await make_conversation(bootstrapped_client)
    v7ish = "01890000-0000-7000-8000-000000000001"
    fm = inbound_prompt_fm(conv_id, v7ish, fm_id="b2b2b2b2-0000-4000-8000-0000000000d4")
    await fm.save(notify=False)
    await ep.process_inbound_prompt(fm.id, conv_id)
    rows = await RemoteWorkerSession.get_all({"conversation_id": conv_id})
    assert len(rows) == 1 and rows[0].id != v7ish
    assert (await FlowMessage.get_one({"id": fm.id})).remote_worker_session_id == rows[0].id


async def test_standing_grant_approves_and_runs(bootstrapped_client, user, monkeypatch):
    ran = _patch_run(monkeypatch)
    conv_id = await make_conversation(bootstrapped_client)
    grant = ContactPermission(contact_user_id="guest-remote", project_id=None,
                              allowed_actions=[PermissionAction.AUTO_APPROVE_SESSION.value])
    await grant.save(notify=False)
    try:
        sid = "b2b2b2b2-0000-4000-8000-0000000000e0"
        fm = inbound_prompt_fm(conv_id, sid, fm_id="b2b2b2b2-0000-4000-8000-0000000000e1")
        await fm.save(notify=False)

        await ep.process_inbound_prompt(fm.id, conv_id)

        session = await RemoteWorkerSession.get_one({"id": sid})
        assert session.status == S.IDLE.value
        assert session.approved_via == "standing_grant" and session.approved_at
        assert ran == [(sid, fm.id)]
        events = await session_messages(conv_id, kind=FlowMessageKind.SESSION_EVENT.value)
        assert any(event_marker(m) == "approved" for m in events)
    finally:
        await grant.delete()


async def test_project_scoped_grant_does_not_leak_to_other_projects(bootstrapped_client, user, monkeypatch):
    ran = _patch_run(monkeypatch)
    conv_id = await make_conversation(bootstrapped_client)
    grant = ContactPermission(contact_user_id="guest-remote", project_id="some-other-project",
                              allowed_actions=[PermissionAction.AUTO_APPROVE_SESSION.value])
    await grant.save(notify=False)
    try:
        sid = "b2b2b2b2-0000-4000-8000-0000000000e2"
        fm = inbound_prompt_fm(conv_id, sid, fm_id="b2b2b2b2-0000-4000-8000-0000000000e3")
        await fm.save(notify=False)
        await ep.process_inbound_prompt(fm.id, conv_id)
        assert ran == []
        assert (await RemoteWorkerSession.get_one({"id": sid})).status == S.PENDING.value
    finally:
        await grant.delete()


async def test_active_session_runs(bootstrapped_client, user, monkeypatch):
    ran = _patch_run(monkeypatch)
    conv_id = await make_conversation(bootstrapped_client)
    for i, status in enumerate((S.IDLE.value, S.RUNNING.value, S.ERROR.value)):
        rws = await make_session(conv_id, status)
        fm = inbound_prompt_fm(conv_id, rws.id, fm_id=f"b2b2b2b2-0000-4000-8000-0000000000f{i}")
        await fm.save(notify=False)
        await ep.process_inbound_prompt(fm.id, conv_id)
        assert (rws.id, fm.id) in ran
    assert len(ran) == 3


async def test_own_sends_and_consumed_prompts_are_skipped(bootstrapped_client, user, monkeypatch):
    ran = _patch_run(monkeypatch)
    conv_id = await make_conversation(bootstrapped_client)
    rws = await make_session(conv_id, S.IDLE.value)
    from flow_sdk.builtin.user import User
    local = await User.get_one({"uname": "local"})
    own = inbound_prompt_fm(conv_id, rws.id, fm_id="b2b2b2b2-0000-4000-8000-0000000000a1", sender_id=local.id)
    await own.save(notify=False)
    done = inbound_prompt_fm(conv_id, rws.id, fm_id="b2b2b2b2-0000-4000-8000-0000000000a2")
    done.prompt_auto_handled = True
    await done.save(notify=False)
    await ep.process_inbound_prompt(own.id, conv_id)
    await ep.process_inbound_prompt(done.id, conv_id)
    assert ran == []
