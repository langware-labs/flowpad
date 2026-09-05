"""Session resolution + PromptCompletion emission that ``run_session_turn``
performs around the worker run. Drives the real helpers against the real DB
(no worker, no mocks) — the worker orchestration itself is covered by
``test_execute_prompt_capture`` / ``test_run_session_turn``.
"""
from __future__ import annotations

import pytest

from flow_sdk.app.actions.execute_prompt import _emit_prompt_completion, resolve_or_mint_session
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.prompt_completion import PromptCompletion
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus

pytestmark = pytest.mark.asyncio


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_resolve_or_mint_session_adopts_guest_id_and_reuses_row(bootstrapped_client, user):
    conv = Conversation(title="rws-resolve", project_id="proj1")
    conv.members = [{"user_id": "guest1", "name": "Bob"}]
    await conv.save(notify=False)
    sid = "c3c3c3c3-0000-4000-8000-0000000000a1"
    fm = FlowMessage(text="x", sender_id="guest1", sender_name="Bob", conversation_id=conv.id,
                     remote_worker_session_id=sid,
                     attachment=[Attachment(attachment_type=AttachmentType.PROMPT, data="go"),
                                 Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"remote_worker_session-{sid}")])
    fm.id = "c3c3c3c3-0000-4000-8000-0000000000a2"
    await fm.save(notify=False)

    a = await resolve_or_mint_session(fm, conv, host_user_id="host1", host_name="Alice")
    assert a.id == sid
    assert (a.status, a.starting_message_id, a.guest_user_id, a.host_user_id) == (RemoteWorkerSessionStatus.PENDING, fm.id, "guest1", "host1")
    assert a.project_id == "proj1"

    a.mark_activity(RemoteWorkerSessionStatus.IDLE)
    await a.save()
    b = await resolve_or_mint_session(fm, conv, host_user_id="host1", host_name="Alice")
    assert b.id == a.id and b.status == RemoteWorkerSessionStatus.IDLE  # reused, status untouched


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_emit_prompt_completion(bootstrapped_client, user):
    att = await _emit_prompt_completion(
        "BANANA", prompt_id="p1", session_id="rws1", host_process_id="ap1", source_session_id="sess1",
    )
    assert att["attachment_type"] == "type_id"
    assert att["data"].startswith("prompt_completion-")
    assert att["prompt_preview"] == "BANANA"

    pr = await PromptCompletion.get_one({"id": att["data"].split("-", 1)[1]})
    assert pr is not None
    assert pr.text == "BANANA"
    assert pr.remote_worker_session_id == "rws1"
    assert pr.host_process_id == "ap1"
    assert pr.status == "complete"
