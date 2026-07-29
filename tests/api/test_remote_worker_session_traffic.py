"""Phase 2 traffic: the RemoteWorkerSession binding + PromptCompletion emission that
``execute_prompt_from_message`` performs around the worker run. Drives the real
helpers against the real DB (no worker, no mocks) — the worker orchestration
itself is covered by ``test_execute_prompt_capture``.
"""
from __future__ import annotations

import pytest

from flow_sdk.app.actions.execute_prompt import _emit_prompt_completion, _reuse_or_bind_session
from flow_sdk.builtin.prompt_completion import PromptCompletion
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus

pytestmark = pytest.mark.asyncio


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_reuse_or_bind_session(bootstrapped_client, user):
    conv = "conv-rws-1"
    a = await _reuse_or_bind_session(
        conversation_id=conv, host_user_id="host1", guest_user_id="guest1",
        host_process_id="ap1", project_id="proj1", status=RemoteWorkerSessionStatus.RUNNING,
    )
    assert a.type == "remote_worker_session"
    assert (a.host_user_id, a.guest_user_id, a.host_process_id) == ("host1", "guest1", "ap1")
    assert a.status == RemoteWorkerSessionStatus.RUNNING

    # Same (conversation, host) → reuse the SAME session, refresh process id + status.
    b = await _reuse_or_bind_session(
        conversation_id=conv, host_user_id="host1", guest_user_id="guest1",
        host_process_id="ap2", project_id="proj1", status=RemoteWorkerSessionStatus.IDLE,
    )
    assert b.id == a.id
    assert b.host_process_id == "ap2"
    assert b.status == RemoteWorkerSessionStatus.IDLE


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
