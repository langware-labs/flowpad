"""The ONE inbound gate — ``process_inbound_prompt`` against the real DB.

The run seam (``run_session_turn``) is patched where a turn would start; the
session resolution, the consent decision and the marker discipline are real.
"""
from __future__ import annotations

import pytest

from flow_sdk.app.actions import execute_prompt as ep
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


async def test_a_contacts_prompt_never_runs_before_the_host_approves(bootstrapped_client, user, monkeypatch):
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


_LONG_AGO = "2026-01-01T00:00:00+00:00"  # far past MAX_SESSION_LENGTH


async def test_prompt_into_a_session_past_the_cap_closes_it(bootstrapped_client, user, monkeypatch):
    """Hard stop: the host never runs a prompt past the length cap — it ends
    the session and posts the ``expired`` line (the guest's indication)."""
    ran = _patch_run(monkeypatch)
    conv_id = await make_conversation(bootstrapped_client)
    rws = await make_session(conv_id, S.IDLE.value, approved_at=_LONG_AGO)
    fm = inbound_prompt_fm(conv_id, rws.id, fm_id="b2b2b2b2-0000-4000-8000-0000000000a9")
    await fm.save(notify=False)

    await ep.process_inbound_prompt(fm.id, conv_id)

    assert ran == []
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status == S.ENDED.value
    events = await session_messages(conv_id, kind=FlowMessageKind.SESSION_EVENT.value)
    assert [event_marker(m) for m in events] == ["expired"]


async def test_sweep_closes_capped_sessions_host_loudly_guest_silently(bootstrapped_client, user):
    conv_id = await make_conversation(bootstrapped_client)
    hosted = await make_session(conv_id, S.RUNNING.value, approved_at=_LONG_AGO, host_process_id="ap-gone")
    guested = await make_session(conv_id, S.IDLE.value, approved_at=_LONG_AGO, host_user_id="someone-else")
    fresh = await make_session(conv_id, S.IDLE.value)

    await ep.close_expired_sessions()

    assert (await RemoteWorkerSession.get_one({"id": hosted.id})).status == S.ENDED.value
    assert (await RemoteWorkerSession.get_one({"id": guested.id})).status == S.ENDED.value
    assert (await RemoteWorkerSession.get_one({"id": fresh.id})).status == S.IDLE.value
    events = await session_messages(conv_id, kind=FlowMessageKind.SESSION_EVENT.value)
    assert [(m.remote_worker_session_id, event_marker(m)) for m in events] == [(hosted.id, "expired")]


async def test_capped_session_is_not_the_open_one(bootstrapped_client, user):
    """A prompt sent after the cap opens a NEW session instead of joining the old one."""
    conv_id = await make_conversation(bootstrapped_client)
    await make_session(conv_id, S.IDLE.value, approved_at=_LONG_AGO)
    assert await RemoteWorkerSession.open_for_conversation(conv_id, "guest-remote") is None


async def test_another_members_prompt_never_runs_under_someones_approval(bootstrapped_client, user, monkeypatch):
    """Bob's session is approved. Carol, another member, sends a prompt — stamped with Bob's
    session id, or with none. Neither joins Bob's session: each opens Carol's own PENDING session
    and runs nothing, while Bob's own follow-up still runs."""
    ran = _patch_run(monkeypatch)
    conv_id = await make_conversation(bootstrapped_client)
    bobs = await make_session(conv_id, S.IDLE.value, guest_user_id="guest-remote")

    stamped = inbound_prompt_fm(conv_id, bobs.id, fm_id="c3c3c3c3-0000-4000-8000-000000000001", sender_id="carol")
    unstamped = inbound_prompt_fm(conv_id, None, fm_id="c3c3c3c3-0000-4000-8000-000000000002", sender_id="carol")
    for fm in (stamped, unstamped):
        await fm.save(notify=False)
        await ep.process_inbound_prompt(fm.id, conv_id)
    assert ran == []
    carols = await RemoteWorkerSession.get_all({"conversation_id": conv_id, "guest_user_id": "carol"})
    assert carols and {s.status for s in carols} == {S.PENDING.value}
    assert all(s.id != bobs.id for s in carols)

    own = inbound_prompt_fm(conv_id, bobs.id, fm_id="c3c3c3c3-0000-4000-8000-000000000003")
    await own.save(notify=False)
    await ep.process_inbound_prompt(own.id, conv_id)
    assert ran == [(bobs.id, own.id)]
