"""``run_session_turn`` against the real DB with the worker seam patched:
marker-before-run, session RUNNING→IDLE, the reply stamped with the session id
+ a prompt_completion attachment + the carrier, review policy → draft, a
failing run → ERROR, and two concurrent turns on one session serialize."""
from __future__ import annotations

import asyncio

import pytest

from flow_sdk.app.actions import execute_prompt as ep
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus as S
from tests.api._session_helpers import inbound_prompt_fm, make_conversation, make_session

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture
def fake_worker(monkeypatch):
    """Patch the two worker seams: ``ap.prompt`` records the text, capture
    answers with a reply derived from it. ``in_flight`` proves serialization."""
    state = {"prompts": [], "in_flight": 0, "max_in_flight": 0, "fail": False}

    async def fake_prompt(self, text, *a, **k):
        state["in_flight"] += 1
        state["max_in_flight"] = max(state["max_in_flight"], state["in_flight"])
        state["prompts"].append(text)
        await asyncio.sleep(0.01)
        state["in_flight"] -= 1
        if state["fail"]:
            raise RuntimeError("worker exploded")

    async def fake_capture(ap):
        return f"reply #{len(state['prompts'])}"

    monkeypatch.setattr(AgenticProcess, "prompt", fake_prompt)
    monkeypatch.setattr(ep, "_capture_assistant_reply", fake_capture)
    return state


async def _someone(user) -> str:
    return str(user.typeid)


def _reply_rows(fms, sid):
    return [m for m in fms if m.remote_worker_session_id == sid
            and any(a.attachment_type == AttachmentType.TYPE_ID and (a.data or "").startswith("prompt_completion-")
                    for a in m.attachment or [])]


async def test_turn_runs_and_replies_in_the_session(bootstrapped_client, user, fake_worker):
    conv_id = await make_conversation(bootstrapped_client)
    conv = await Conversation.get_one({"id": conv_id})
    rws = await make_session(conv_id, S.IDLE.value)
    fm = inbound_prompt_fm(conv_id, rws.id, fm_id="d4d4d4d4-0000-4000-8000-0000000000a1")
    await fm.save(notify=False)

    result = await ep.run_session_turn(rws, fm, conv, someone_typeid=await _someone(user))
    assert result.status == "SUCCESS", getattr(result, "message", None)

    assert (await FlowMessage.get_one({"id": fm.id})).prompt_auto_handled is True
    assert "run the tests" in fake_worker["prompts"][0]
    assert f"live session {rws.id}" in fake_worker["prompts"][0]  # file-return context block
    after = await RemoteWorkerSession.get_one({"id": rws.id})
    assert after.status == S.IDLE.value and after.host_process_id
    [reply] = _reply_rows(await FlowMessage.get_all({"conversation_id": conv_id}), rws.id)
    assert reply.is_draft is False
    assert reply.text.startswith('Prompt response: "reply #1')
    assert any(a.data == f"remote_worker_session-{rws.id}" for a in reply.attachment)


async def test_review_policy_saves_the_reply_as_a_draft(bootstrapped_client, user, fake_worker):
    conv_id = await make_conversation(bootstrapped_client)
    conv = await Conversation.get_one({"id": conv_id})
    rws = await make_session(conv_id, S.IDLE.value, reply_policy="review")
    fm = inbound_prompt_fm(conv_id, rws.id, fm_id="d4d4d4d4-0000-4000-8000-0000000000b1")
    await fm.save(notify=False)

    result = await ep.run_session_turn(rws, fm, conv, someone_typeid=await _someone(user))
    assert result.status == "SUCCESS"
    assert result.data["reply_policy"] == "review"
    [reply] = _reply_rows(await FlowMessage.get_all({"conversation_id": conv_id}), rws.id)
    assert reply.is_draft is True
    assert reply.remote_worker_session_id == rws.id


async def test_failed_run_marks_error_and_keeps_the_marker(bootstrapped_client, user, fake_worker):
    fake_worker["fail"] = True
    conv_id = await make_conversation(bootstrapped_client)
    conv = await Conversation.get_one({"id": conv_id})
    rws = await make_session(conv_id, S.IDLE.value)
    fm = inbound_prompt_fm(conv_id, rws.id, fm_id="d4d4d4d4-0000-4000-8000-0000000000c1")
    await fm.save(notify=False)

    result = await ep.run_session_turn(rws, fm, conv, someone_typeid=await _someone(user))
    assert result.status != "SUCCESS"
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status == S.ERROR.value
    assert (await FlowMessage.get_one({"id": fm.id})).prompt_auto_handled is True
    assert _reply_rows(await FlowMessage.get_all({"conversation_id": conv_id}), rws.id) == []


async def test_concurrent_turns_on_one_session_serialize(bootstrapped_client, user, fake_worker):
    conv_id = await make_conversation(bootstrapped_client)
    conv = await Conversation.get_one({"id": conv_id})
    rws = await make_session(conv_id, S.IDLE.value)
    fms = []
    for i in range(4):
        fm = inbound_prompt_fm(conv_id, rws.id, fm_id=f"d4d4d4d4-0000-4000-8000-0000000000e{i}")
        await fm.save(notify=False)
        fms.append(fm)
    someone = await _someone(user)
    results = await asyncio.gather(*(ep.run_session_turn(rws, fm, conv, someone_typeid=someone) for fm in fms))
    assert all(r.status == "SUCCESS" for r in results)
    assert fake_worker["max_in_flight"] == 1
    assert len(_reply_rows(await FlowMessage.get_all({"conversation_id": conv_id}), rws.id)) == 4
