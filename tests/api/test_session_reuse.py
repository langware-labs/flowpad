"""One open live session per conversation.

Prompts sent into a conversation join its open session — queued while it awaits
approval, run in order once approved — instead of each opening a session of its
own (2026-10-05: four prompts to one host became four sessions, four cards).
Only after the session ends does the next prompt open another.

Guest side through the real ``add_message`` route (``is_draft``: the local-only
path that skips the cloud gate); host side through the real inbound gate and
approve route, with only the worker seam patched (``fake_worker``).
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from flow_sdk.app.actions import execute_prompt as ep
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus as S
from tests.api._session_helpers import inbound_prompt_fm, make_conversation, make_session
from tests.api.test_run_session_turn import fake_worker  # noqa: F401 — the shared worker seam

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _send_prompt(client, conv_id: str, text: str) -> FlowMessage:
    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"message": "", "prompt_text": text, "is_draft": True},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    return await FlowMessage.get_one({"id": resp.json()["data"]["flow_message_id"]})


def _opens_a_session(fm: FlowMessage) -> bool:
    return any(
        a.attachment_type == AttachmentType.TYPE_ID and "session_start" in (a.prompt_preview or "")
        for a in fm.attachment or []
    )


async def test_prompts_in_one_conversation_join_its_open_session(bootstrapped_client, user):
    conv_id = await make_conversation(bootstrapped_client)
    first = await _send_prompt(bootstrapped_client, conv_id, "what is your git user name")
    second = await _send_prompt(bootstrapped_client, conv_id, "does it cover langware too")

    assert second.remote_worker_session_id == first.remote_worker_session_id
    assert _opens_a_session(first) and not _opens_a_session(second)
    assert len(await RemoteWorkerSession.get_all({"conversation_id": conv_id})) == 1


async def test_after_the_session_ends_the_next_prompt_opens_another(bootstrapped_client, user):
    conv_id = await make_conversation(bootstrapped_client)
    first = await _send_prompt(bootstrapped_client, conv_id, "first question")
    session = await RemoteWorkerSession.get_one({"id": first.remote_worker_session_id})
    session.status = S.ENDED.value
    await session.save()

    second = await _send_prompt(bootstrapped_client, conv_id, "a new question later")
    assert second.remote_worker_session_id != first.remote_worker_session_id
    assert _opens_a_session(second)


async def test_an_unstamped_prompt_on_the_host_joins_the_open_session(bootstrapped_client, user):
    conv_id = await make_conversation(bootstrapped_client)
    rws = await make_session(conv_id, S.IDLE.value)
    fm = inbound_prompt_fm(conv_id, None, fm_id=str(uuid.uuid4()))
    await fm.save(notify=False)

    conv = await Conversation.get_one({"id": conv_id})
    session = await ep.resolve_or_mint_session(fm, conv, host_user_id="host-local", host_name="Alice")
    assert session.id == rws.id


async def test_prompts_queued_while_pending_all_run_in_order_on_approve(bootstrapped_client, user, fake_worker):  # noqa: F811
    conv_id = await make_conversation(bootstrapped_client)
    rws = await make_session(conv_id, S.PENDING.value)
    queued = []
    for text in ("TURN-ALPHA", "TURN-BRAVO", "TURN-CHARLIE"):
        fm = inbound_prompt_fm(conv_id, rws.id, fm_id=str(uuid.uuid4()))
        fm.attachment[0].data = text
        await fm.save(notify=False)
        queued.append(fm)
        await ep.process_inbound_prompt(fm.id, conv_id)  # parks: the session awaits approval
    assert fake_worker["prompts"] == []

    resp = await bootstrapped_client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={})
    assert resp.json().get("status") == "SUCCESS", resp.text
    await asyncio.gather(
        *[
            t
            for t in asyncio.all_tasks()
            if t is not asyncio.current_task() and "redrive_session_prompts" in repr(t.get_coro())
        ]
    )

    ran = [next(w for w in ("TURN-ALPHA", "TURN-BRAVO", "TURN-CHARLIE") if w in p) for p in fake_worker["prompts"]]
    assert ran == ["TURN-ALPHA", "TURN-BRAVO", "TURN-CHARLIE"]
    assert len(await RemoteWorkerSession.get_all({"conversation_id": conv_id})) == 1


async def test_a_prompt_that_fails_before_running_is_not_left_queued(bootstrapped_client, user, fake_worker):  # noqa: F811
    """Its failure line answers it; the guest's Retry is the one re-run. Left
    queued, the next drain would run it again on top of the Retry."""
    conv_id = await make_conversation(bootstrapped_client)
    rws = await make_session(conv_id, S.IDLE.value, project_id=str(uuid.uuid4()))  # a project that is gone
    fm = inbound_prompt_fm(conv_id, rws.id, fm_id=str(uuid.uuid4()))
    await fm.save(notify=False)

    await ep.process_inbound_prompt(fm.id, conv_id)

    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status == S.ERROR.value
    assert (await FlowMessage.get_one({"id": fm.id})).prompt_auto_handled is True
    assert await ep._queued_turns(rws, None) == []
    assert fake_worker["prompts"] == []
