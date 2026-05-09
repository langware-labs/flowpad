"""Integration test: per-process sniffer fan-out from listen.handle_agent_hook.

When a Claude hook webhook arrives at ``/api/v1/webhook/listen`` and the
hook's ``session_id`` (or ``execution_scope``) matches an existing
``AgenticProcess``, the listener must:

1. Continue to ingest the event into the global ``AgentHook.flow_data_stream``
   (the project-wide sniffer view depends on this) — already covered by the
   existing ``test_listen_action_with_agent_hook_trigger``.
2. *Additionally*, convert the payload to a generic ``FlowData``
   (``element_type=status``, ``source=sniffer``) and emit it onto the
   matching ``AgenticProcess.flow_data_stream``.

Backend ``emit_flow_data`` dispatches over WS via
``send_flow_data_to_entity``; we monkeypatch that helper to capture the calls
without touching the wire protocol.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from flow_sdk.builtin.agent_hook import AgentHook, AgentProvider, HookScope
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus

pytestmark = pytest.mark.usefixtures("reset_db_for_testclient")


@pytest.mark.asyncio
async def test_per_process_fanout_emits_sniffer_flow_data(bootstrapped_client, user):
    """A hook event with session_id=X for a known AgenticProcess should
    emit a `source=sniffer` FlowData onto that process's stream in addition
    to the global AgentHook ingest."""
    client = bootstrapped_client

    # Spawn a minimal AgenticProcess with a known session_id.
    session_id = "test-fanout-session-12345"
    process = AgenticProcess(name="fanout-test", session_id=session_id)
    await process.save(user.typeid)

    # Spawn an AgentHook so the global ingest path runs (mirrors prod setup).
    hook = AgentHook(
        name="fanout-test-hook",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="PreToolUse",
        enabled=True,
    )
    await hook.save(user.typeid)

    # Capture all send_flow_data_to_entity calls — the dispatch primitive used
    # by Entity.emit_flow_data. Each call is (typeid, frontend_flow_data).
    captured: list[tuple[object, dict]] = []

    async def fake_send(typeid, payload):
        captured.append((typeid, payload))

    payload = {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": hook.id,
            "hook_data": {
                "hook_event_name": "PreToolUse",
                "session_id": session_id,
                "tool_name": "Read",
                "tool_use_id": "toolu_abc",
            },
        },
    }

    with patch(
        "flow_sdk.core.network.resource_tracker.send_flow_data_to_entity",
        side_effect=fake_send,
    ):
        response = await client.post("/api/v1/webhook/listen", json=payload)

    assert response.status_code == 200, response.text
    res = ApiResponse(**response.json())
    assert res.status == ApiResponseStatus.SUCCESS.value

    # Two flow-data emissions: one to AgentHook (global sniffer), one to
    # AgenticProcess (per-process fan-out). Neither is sensitive to ordering.
    target_types = {tid.type for tid, _ in captured}
    assert AgentHook.get_type() in target_types, (
        f"global AgentHook ingest missing — captured: {captured}"
    )
    assert AgenticProcess.get_type() in target_types, (
        f"per-process fan-out missing — captured: {captured}"
    )

    # Pick out the AgenticProcess emission and verify it's the converted
    # sniffer FlowData (STATUS element-type, source=sniffer).
    process_payloads = [p for tid, p in captured if tid.type == AgenticProcess.get_type()]
    assert len(process_payloads) == 1
    fd_payload = process_payloads[0]
    attrs = fd_payload["attributes"]
    assert attrs["element-type"] == "status"
    assert attrs["source"] == "sniffer"
    assert attrs["subtype"] == "PreToolUse"
    assert attrs["tool-name"] == "Read"
    assert attrs["tool-use-id"] == "toolu_abc"
    assert attrs["webhook-type"] == "agent_hook"

    # Cleanup
    await hook.delete()
    await process.delete()


@pytest.mark.asyncio
async def test_per_process_fanout_skipped_for_unknown_session(bootstrapped_client, user):
    """Hook events whose session_id doesn't match any AgenticProcess should
    leave the global ingest intact and emit *nothing* per-process."""
    client = bootstrapped_client

    hook = AgentHook(
        name="fanout-orphan-hook",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="PreToolUse",
        enabled=True,
    )
    await hook.save(user.typeid)

    captured: list[tuple[object, dict]] = []

    async def fake_send(typeid, payload):
        captured.append((typeid, payload))

    payload = {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": hook.id,
            "hook_data": {
                "hook_event_name": "PreToolUse",
                "session_id": "session-with-no-process",
                "tool_name": "Bash",
            },
        },
    }

    with patch(
        "flow_sdk.core.network.resource_tracker.send_flow_data_to_entity",
        side_effect=fake_send,
    ):
        response = await client.post("/api/v1/webhook/listen", json=payload)

    assert response.status_code == 200, response.text

    # Global AgentHook ingest still runs.
    target_types = {tid.type for tid, _ in captured}
    assert AgentHook.get_type() in target_types
    # No AgenticProcess emit — nothing to fan out to.
    assert AgenticProcess.get_type() not in target_types

    await hook.delete()
