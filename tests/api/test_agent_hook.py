"""
API tests for agent hook listen action and trigger execution.

Migrated from FlowPad: old_flowpad_repo/flowpad/flowpad/hub/tests/api/test_agent_hook.py
Classification: ADAPT (grant_role calls removed, uses webhook/listen endpoint)

Tests the listen action's ability to:
1. Process agent hook data and execute trigger actions
2. Increment counters on multiple calls
3. Skip non-matching triggers
4. Skip disabled triggers
5. Handle NOP action type
6. E2E: sniffer webhook → WebSocket watch → /listen POST → flow_data_msg received
"""

import json
import uuid

import pytest

from flow_sdk.builtin.agent_hook import AgentHook, AgentProvider, HookScope
from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.flowpad_types.enums.entity_enums import BuiltInRelationshipTypes, RelationshipDirection
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus

# Reset DB state before every test so TestClient gets a fresh event-loop session
# and async tests reinitialise the DB in the pytest event loop each time.
pytestmark = pytest.mark.usefixtures("reset_db_for_testclient")


@pytest.mark.asyncio
async def test_listen_action_with_agent_hook_trigger(bootstrapped_client, user):
    """
    Test that the listen action processes agent hook data and executes trigger actions.

    Steps:
    1. Create a test AgentHook entity
    2. Create a trigger with NOTIFY_ENTITY action and simple mask
    3. Connect the trigger to the AgentHook via ConnectedTo relationship
    4. Call listen action on the AgentHook with matching agent_hook data
    5. Verify the trigger counter was incremented
    """
    client = bootstrapped_client

    # Step 1: Create test entity (AgentHook)
    test_entity = AgentHook(
        name="test_agent_hook",
        description="AgentHook for testing listen action",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="UserPromptSubmit",
        enabled=True,
    )
    await test_entity.save(user.typeid)

    # Step 2: Create trigger with NOTIFY_ENTITY action
    trigger = Trigger(
        name="test_notify_trigger",
        description="Trigger that matches UserPromptSubmit and increments counter",
        mask={"hook_event_name": "UserPromptSubmit"},
        action=TriggerAction(action_type=ActionType.NOTIFY_ENTITY),
        enabled=True,
    )
    await trigger.save(user.typeid)

    # Verify initial counter is 0
    assert trigger.counter == 0

    # Step 3: Connect trigger to test entity via ConnectedTo relationship
    await test_entity.save_relationship(
        to_e=trigger.typeid,
        relationship_or_str=BuiltInRelationshipTypes.ConnectedTo,
        direction=RelationshipDirection.Outgoing,
    )

    # Step 4: Call listen action with matching agent_hook data
    payload = {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": test_entity.id,
            "hook_data": {
                "hook_event_name": "UserPromptSubmit",
                "prompt": "Hello, world!",
            },
        },
    }

    response = await client.post("/api/v1/webhook/listen", json=payload)

    assert response.status_code == 200, f"Listen action failed: {response.text}"

    res = ApiResponse(**response.json())
    assert res.status == ApiResponseStatus.SUCCESS.value
    assert res.data["status"] == "processed"
    assert res.data["matched_triggers"] == 1, f"Expected 1 matched trigger, got {res.data}"
    assert len(res.data["executed_actions"]) == 1
    assert res.data["executed_actions"][0]["action_type"] == ActionType.NOTIFY_ENTITY
    assert res.data["executed_actions"][0]["counter"] == 1

    # Step 5: Verify trigger counter was updated in database
    trigger_reloaded = await Trigger.get_by_typeid(trigger.typeid)
    assert trigger_reloaded.counter == 1
    assert trigger_reloaded.last_triggered is not None

    # Cleanup
    await test_entity.delete()
    await trigger.delete()


@pytest.mark.asyncio
async def test_listen_action_counter_increments_multiple_times(bootstrapped_client, user):
    """
    Test that the trigger counter increments correctly on multiple listen calls.
    """
    client = bootstrapped_client

    # Create test entity
    test_entity = AgentHook(
        name="test_agent_hook_multi",
        description="AgentHook for testing multiple counter increments",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="PreToolUse",
        enabled=True,
    )
    await test_entity.save(user.typeid)

    # Create trigger
    trigger = Trigger(
        name="test_multi_trigger",
        mask={"hook_event_name": "PreToolUse"},
        action=TriggerAction(action_type=ActionType.NOTIFY_ENTITY),
        enabled=True,
    )
    await trigger.save(user.typeid)

    # Connect trigger to test entity
    await test_entity.save_relationship(
        to_e=trigger.typeid,
        relationship_or_str=BuiltInRelationshipTypes.ConnectedTo,
        direction=RelationshipDirection.Outgoing,
    )

    # Call listen 3 times
    flow_data = {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": test_entity.id,
            "hook_data": {
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
            },
        },
    }

    for i in range(3):
        response = await client.post("/api/v1/webhook/listen", json=flow_data)
        assert response.status_code == 200
        res = ApiResponse(**response.json())
        assert res.data["executed_actions"][0]["counter"] == i + 1

    # Verify final counter
    trigger_reloaded = await Trigger.get_by_typeid(trigger.typeid)
    assert trigger_reloaded.counter == 3

    # Cleanup
    await test_entity.delete()
    await trigger.delete()


@pytest.mark.asyncio
async def test_listen_action_no_match(bootstrapped_client, user):
    """
    Test that triggers that don't match the hook data are not executed.
    """
    client = bootstrapped_client

    # Create test entity
    test_entity = AgentHook(
        name="test_agent_hook_no_match",
        description="AgentHook for testing no match scenario",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="UserPromptSubmit",
        enabled=True,
    )
    await test_entity.save(user.typeid)

    # Create trigger with mask that won't match
    trigger = Trigger(
        name="test_no_match_trigger",
        mask={"hook_event_name": "NonExistentEvent"},
        action=TriggerAction(action_type=ActionType.NOTIFY_ENTITY),
        enabled=True,
    )
    await trigger.save(user.typeid)

    # Connect trigger to test entity
    await test_entity.save_relationship(
        to_e=trigger.typeid,
        relationship_or_str=BuiltInRelationshipTypes.ConnectedTo,
        direction=RelationshipDirection.Outgoing,
    )

    # Call listen with non-matching data
    flow_data = {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": test_entity.id,
            "hook_data": {
                "hook_event_name": "UserPromptSubmit",
            },
        },
    }

    response = await client.post("/api/v1/webhook/listen", json=flow_data)

    assert response.status_code == 200
    res = ApiResponse(**response.json())
    assert res.data["status"] == "processed"
    assert res.data["matched_triggers"] == 0
    assert len(res.data["executed_actions"]) == 0

    # Verify counter was not incremented
    trigger_reloaded = await Trigger.get_by_typeid(trigger.typeid)
    assert trigger_reloaded.counter == 0
    assert trigger_reloaded.last_triggered is None

    # Cleanup
    await test_entity.delete()
    await trigger.delete()


@pytest.mark.asyncio
async def test_listen_action_disabled_trigger(bootstrapped_client, user):
    """
    Test that disabled triggers are not executed.
    """
    client = bootstrapped_client

    # Create test entity
    test_entity = AgentHook(
        name="test_agent_hook_disabled",
        description="AgentHook for testing disabled trigger",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="UserPromptSubmit",
        enabled=True,
    )
    await test_entity.save(user.typeid)

    # Create disabled trigger
    trigger = Trigger(
        name="test_disabled_trigger",
        mask={"hook_event_name": "UserPromptSubmit"},
        action=TriggerAction(action_type=ActionType.NOTIFY_ENTITY),
        enabled=False,  # Disabled
    )
    await trigger.save(user.typeid)

    # Connect trigger to test entity
    await test_entity.save_relationship(
        to_e=trigger.typeid,
        relationship_or_str=BuiltInRelationshipTypes.ConnectedTo,
        direction=RelationshipDirection.Outgoing,
    )

    # Call listen with matching data
    flow_data = {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": test_entity.id,
            "hook_data": {
                "hook_event_name": "UserPromptSubmit",
            },
        },
    }

    response = await client.post("/api/v1/webhook/listen", json=flow_data)

    assert response.status_code == 200
    res = ApiResponse(**response.json())
    assert res.data["matched_triggers"] == 0

    # Verify counter was not incremented
    trigger_reloaded = await Trigger.get_by_typeid(trigger.typeid)
    assert trigger_reloaded.counter == 0

    # Cleanup
    await test_entity.delete()
    await trigger.delete()


@pytest.mark.asyncio
async def test_listen_action_nop_action(bootstrapped_client, user):
    """
    Test that NOP action type doesn't increment counter but still updates last_triggered.
    """
    client = bootstrapped_client

    # Create test entity
    test_entity = AgentHook(
        name="test_agent_hook_nop",
        description="AgentHook for testing NOP action",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="Stop",
        enabled=True,
    )
    await test_entity.save(user.typeid)

    # Create trigger with NOP action
    trigger = Trigger(
        name="test_nop_trigger",
        mask={"hook_event_name": "Stop"},
        action=TriggerAction(action_type=ActionType.NOP),
        enabled=True,
    )
    await trigger.save(user.typeid)

    # Connect trigger to test entity
    await test_entity.save_relationship(
        to_e=trigger.typeid,
        relationship_or_str=BuiltInRelationshipTypes.ConnectedTo,
        direction=RelationshipDirection.Outgoing,
    )

    # Call listen
    flow_data = {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agent_hook_id": test_entity.id,
            "hook_data": {
                "hook_event_name": "Stop",
            },
        },
    }

    response = await client.post("/api/v1/webhook/listen", json=flow_data)

    assert response.status_code == 200
    res = ApiResponse(**response.json())
    assert res.data["matched_triggers"] == 1
    assert res.data["executed_actions"][0]["action_type"] == ActionType.NOP
    assert res.data["executed_actions"][0]["counter"] == 0  # NOP doesn't increment

    # Verify last_triggered was updated but counter stayed at 0
    trigger_reloaded = await Trigger.get_by_typeid(trigger.typeid)
    assert trigger_reloaded.counter == 0
    assert trigger_reloaded.last_triggered is not None

    # Cleanup
    await test_entity.delete()
    await trigger.delete()


def test_sniffer_webhook_e2e_via_websocket():
    """
    E2E test: configure @sniffer → watch via WebSocket → POST to /listen → validate flow_data_msg.

    Steps:
    1. Enable sniffer hook via POST /api/v1/graph/agent_hook/hooks-sniffer
    2. Open a WebSocket connection
    3. Register a watch on the sniffer entity so the connection receives its events
    4. POST to /api/v1/webhook/listen with a skill_notification webhook
    5. Verify the WebSocket receives a flow_data_msg with the webhook payload
    """
    from flow_sdk.server.app import app
    from starlette.testclient import TestClient

    with TestClient(app) as tc:
        # 1. Bootstrap (idempotent — entities may already exist from fixtures)
        resp = tc.get("/api/v1/graph/bootstrap")
        assert resp.status_code == 200

        # 2. Enable sniffer hook
        resp = tc.post("/api/v1/graph/agent_hook/hooks-sniffer")
        assert resp.status_code == 200, f"hooks-sniffer failed: {resp.text}"
        sniffer_data = resp.json()["data"]
        assert sniffer_data["enabled"] is True
        sniffer_hook_id = sniffer_data["hook_id"]

        # 3. Open WebSocket and register watch on sniffer entity
        conn_id = str(uuid.uuid4())
        with tc.websocket_connect(f"/api/v1/connect/ws/{conn_id}") as ws:
            # Consume connection confirmation
            confirm = ws.receive_json()
            assert confirm["message_type"] == "response_msg"
            assert confirm["status"] == "ok"

            # Register watch on the sniffer hook entity
            resp = tc.post(
                f"/api/v1/graph/agent_hook/{sniffer_hook_id}/watch",
                json={"connection_id": conn_id},
            )
            assert resp.status_code == 200, f"watch failed: {resp.text}"

            # 4. POST to /listen with a hook_op skill event
            payload = {
                "webhook_type": "hook_op",
                "webhook_payload": {
                    "type": "skill",
                    "id": "sniffer-skill-1",
                    "operation": "event",
                    "data": {
                        "event_name": "skill_activated",
                        "event_data": {
                            "notification": {
                                "skill_name": "test-sniffer-skill",
                                "matched_keyword": "test",
                                "prompt": "hello from e2e test",
                            },
                        },
                    },
                },
            }
            resp = tc.post("/api/v1/webhook/listen", json=payload)
            assert resp.status_code == 200, f"listen failed: {resp.text}"

            # 5. Receive flow_data_msg on WebSocket
            msg = ws.receive_json()
            assert msg["message_type"] == "flow_data_msg", (
                f"Expected flow_data_msg, got: {json.dumps(msg, indent=2)}"
            )
            # Verify the flow_data contains the webhook payload
            flow_data = msg["flow_data"]
            assert flow_data["attributes"]["webhook_type"] == "hook_op"
            # content is JSON-serialized by emit_flow_data
            content = json.loads(flow_data["content"])
            assert content["webhook_type"] == "hook_op"
            assert content["type"] == "skill"
