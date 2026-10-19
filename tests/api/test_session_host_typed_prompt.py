"""The host may type into its own live session — the prompt runs on the host.

Two sides of one rule: the host's own send is drained on the host, and the
guest, which receives that prompt over the conversation too, leaves it alone
(its mirror has no project — running it could only fail and report the
failure as the host's).
"""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.app.actions import execute_prompt as ep
from flow_sdk.app.actions import notification_action as na
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus as S
from tests.api._session_helpers import inbound_prompt_fm, make_conversation, make_session

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_guest_ignores_the_hosts_prompt(bootstrapped_client, user, monkeypatch):
    ran: list[str] = []

    async def fake_run(session, fm, conv, *, someone_typeid, **_kw):
        ran.append(fm.id)

    monkeypatch.setattr(ep, "run_session_turn", fake_run)
    conv_id = await make_conversation(bootstrapped_client)
    # This machine is the GUEST: the session row names the local user as guest.
    rws = await make_session(conv_id, S.IDLE.value, host_user_id="host-remote", guest_user_id=user.id)
    fm = inbound_prompt_fm(conv_id, rws.id, fm_id="c3c3c3c3-0000-4000-8000-000000000001", sender_id="host-remote")
    await fm.save(notify=False)

    await ep.process_inbound_prompt(fm.id, conv_id)

    assert ran == []
    assert (await FlowMessage.get_one({"id": fm.id})).prompt_auto_handled is False


async def test_hosts_own_prompt_is_drained_here(bootstrapped_client, user, monkeypatch):
    drained: list[str] = []

    async def fake_drain(session, **_kw):
        drained.append(session.id)

    monkeypatch.setattr(ep, "redrive_session_prompts", fake_drain)
    conv_id = await make_conversation(bootstrapped_client)
    rws = await make_session(conv_id, S.IDLE.value, host_process_id="proc-1")

    await na._run_if_hosted_here(rws.id)
    await asyncio.sleep(0)

    assert drained == [rws.id]


async def test_hosts_own_prompt_is_queued_for_the_drain(bootstrapped_client, user):
    conv_id = await make_conversation(bootstrapped_client)
    rws = await make_session(conv_id, S.IDLE.value, host_user_id=user.id)
    fm = inbound_prompt_fm(conv_id, rws.id, fm_id="c3c3c3c3-0000-4000-8000-000000000002", sender_id=user.id)
    await fm.save(notify=False)

    assert [m.id for m in await ep._queued_turns(rws)] == [fm.id]
