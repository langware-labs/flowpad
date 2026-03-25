"""
API tests for execution tracing / listen action webhook handling.

Migrated from FlowPad: old_flowpad_repo/flowpad/flowpad/hub/tests/api/test_execution_trace.py
Classification: PARTIAL
- Ported: instruction_trace via hook_op event dispatch
- Ported: skill_notification via hook_op event dispatch
- Ported: activation_rules via hook_op event dispatch
- Skipped: WebSocket routing tests (require ws_connect fixture, Connection entity, FlowpadService)
- Skipped: Trace file writing (desktop mode skips Flow entity trace persistence)

NOTE: After webhook consolidation, instruction_trace/skill_notification/activation_rules
payloads are sent as hook_op events. The tests below use the hook_op envelope.
"""

import pytest

from flow_sdk.responses.response import ApiResponseStatus


@pytest.mark.asyncio
async def test_listen_action_receives_instruction_trace(bootstrapped_client):
    """
    Test that hook_op event with instruction_trace event_name is accepted.
    """
    client = bootstrapped_client

    payload = {
        "webhook_type": "hook_op",
        "webhook_payload": {
            "type": "skill",
            "id": "instruction-trace-1",
            "operation": "event",
            "data": {
                "event_name": "instruction_trace",
                "event_data": {
                    "execution_scope": [
                        {"type": "flow", "id": "test-flow-id"},
                        {"type": "agent", "id": "test-agent-id"},
                    ],
                    "report": {
                        "instruction_id": "step_1",
                        "instruction_text": "echo 'hello world'",
                        "status": "pass",
                    },
                },
            },
            "execution_scope": [
                {"type": "flow", "id": "test-flow-id"},
                {"type": "agent", "id": "test-agent-id"},
            ],
        },
    }

    response = await client.post("/api/v1/webhook/listen", json=payload)
    assert response.status_code == 200, f"Listen action failed: {response.text}"
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["status"] == "received"


@pytest.mark.asyncio
async def test_skill_notification_webhook(bootstrapped_client):
    """
    Test that skill_notification events work through hook_op.
    """
    client = bootstrapped_client

    payload = {
        "webhook_type": "hook_op",
        "webhook_payload": {
            "type": "skill",
            "id": "skill-notif-1",
            "operation": "event",
            "data": {
                "event_name": "skill_activated",
                "event_data": {
                    "notification": {
                        "skill_name": "skillit",
                        "matched_keyword": "skillit",
                        "prompt": "skillit analyze this code",
                        "handler_name": "handle_analyze",
                        "folder_path": "/home/user/project",
                    },
                },
            },
            "execution_scope": [
                {"type": "flow", "id": "skill-notif-flow"},
                {"type": "agent", "id": "skill-notif-agent"},
            ],
        },
    }

    response = await client.post("/api/v1/webhook/listen", json=payload)

    assert response.status_code == 200, f"Listen action failed: {response.text}"
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["status"] == "received"

    # Verify notification data is returned
    notification = res["data"]["notification"]
    assert notification["skill_name"] == "skillit"
    assert notification["matched_keyword"] == "skillit"
    assert notification["handler_name"] == "handle_analyze"
    assert notification["folder_path"] == "/home/user/project"


@pytest.mark.asyncio
async def test_unknown_webhook_type_returns_error(bootstrapped_client):
    """
    Test that an unknown webhook_type returns an error.
    """
    client = bootstrapped_client

    payload = {
        "webhook_type": "unknown_type",
        "webhook_payload": {"some": "data"},
    }

    response = await client.post("/api/v1/webhook/listen", json=payload)
    assert response.status_code == 200  # Action returns 200 with FAIL status
    res = response.json()
    assert res["status"] == "FAIL"


@pytest.mark.asyncio
async def test_activation_rules_webhook(bootstrapped_client):
    """
    Test that activation_rules events work through hook_op.
    """
    client = bootstrapped_client

    payload = {
        "webhook_type": "hook_op",
        "webhook_payload": {
            "type": "skill",
            "id": "activation-1",
            "operation": "event",
            "data": {
                "event_name": "started_generating_skill",
                "event_data": {
                    "context": {
                        "skill_name": "test_skill",
                        "session_id": "test-session-123",
                        "cwd": "/home/user/project",
                    },
                },
            },
        },
    }

    response = await client.post("/api/v1/webhook/listen", json=payload)
    assert response.status_code == 200, f"Listen action failed: {response.text}"
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["status"] == "received"
    assert res["data"]["event"]["type"] == "started_generating_skill"
