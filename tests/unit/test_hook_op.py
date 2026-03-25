"""Unit tests for HookOpPayload and related models."""

import pytest
from pydantic import ValidationError

from flow_sdk.core.flow.models.hook_op import (
    ExecutionScopeEntry,
    HookOpPayload,
    RecordType,
    RefType,
    RelationshipType,
    ResourceSyncPayload,
    ResourceType,
    SyncOperation,
)
from flow_sdk.core.flow.models.webhook_flow_data import WebhookPayload, WebhookType


class TestHookOpPayloadParsing:
    """Tests for parsing HookOpPayload from raw dicts."""

    def test_task_create(self):
        payload = HookOpPayload(
            type="task",
            id="analysis-sess-1",
            operation="create",
            data={"title": "My Task", "status": "in_progress"},
        )
        assert payload.type == RecordType.TASK
        assert payload.operation == SyncOperation.CREATE
        assert payload.id == "analysis-sess-1"
        assert payload.data["title"] == "My Task"
        assert payload.ref_type == RefType.DATA
        assert not payload.is_event

    def test_task_update(self):
        payload = HookOpPayload(
            type="task",
            id="analysis-sess-1",
            operation="update",
            data={"status": "completed", "description": "Done"},
        )
        assert payload.operation == SyncOperation.UPDATE
        assert payload.data["status"] == "completed"

    def test_skill_event_with_execution_scope(self):
        payload = HookOpPayload(
            type="skill",
            id="my-skill",
            operation="event",
            data={
                "event_name": "skill_activated",
                "event_data": {
                    "notification": {"skill_name": "skillit"},
                },
            },
            execution_scope=[
                {"type": "flow", "id": "flow-123"},
                {"type": "session", "id": "sess-abc"},
            ],
        )
        assert payload.is_event
        assert payload.event_name == "skill_activated"
        assert payload.event_data["notification"]["skill_name"] == "skillit"
        assert len(payload.execution_scope) == 2
        assert payload.execution_scope[0].type == "flow"
        assert payload.execution_scope[1].id == "sess-abc"

    def test_event_requires_event_name(self):
        with pytest.raises(ValidationError, match="event_name"):
            HookOpPayload(
                type="skill",
                id="my-skill",
                operation="event",
                data={"some_other_field": "value"},
            )

    def test_crud_does_not_require_event_name(self):
        payload = HookOpPayload(
            type="task",
            id="task-1",
            operation="create",
            data={},
        )
        assert payload.event_name is None

    def test_delete_operation(self):
        payload = HookOpPayload(
            type="rule",
            id="rule-1",
            operation="delete",
        )
        assert payload.operation == SyncOperation.DELETE
        assert payload.data == {}

    def test_ref_type_path(self):
        payload = HookOpPayload(
            type="log",
            id="log-1",
            operation="event",
            ref_type="path",
            data={"event_name": "log_written"},
        )
        assert payload.ref_type == RefType.PATH

    def test_execution_scope_entry(self):
        entry = ExecutionScopeEntry(type="flow", id="f-1")
        assert entry.type == "flow"
        assert entry.id == "f-1"

    def test_invoke_operation(self):
        """INVOKE operation accepts arbitrary types without entity validation."""
        payload = HookOpPayload(
            type="task_created",
            id="task-1",
            operation="invoke",
            data={"title": "New Task"},
        )
        assert payload.operation == SyncOperation.INVOKE

    def test_log_operation(self):
        """LOG operation accepts arbitrary types without entity validation."""
        payload = HookOpPayload(
            type="debug",
            id="log-entry-1",
            operation="log",
            data={"message": "something happened"},
        )
        assert payload.operation == SyncOperation.LOG

    def test_backward_compat_alias(self):
        """ResourceSyncPayload is an alias for HookOpPayload."""
        assert ResourceSyncPayload is HookOpPayload


class TestWebhookPayloadAcceptsHookOp:
    """Test that WebhookPayload accepts hook_op as a valid webhook_type."""

    def test_hook_op_webhook_type(self):
        envelope = WebhookPayload(
            webhook_type="hook_op",
            webhook_payload={
                "type": "task",
                "id": "task-1",
                "operation": "create",
            },
        )
        assert envelope.webhook_type == WebhookType.HOOK_OP

    def test_enum_contains_hook_op(self):
        assert WebhookType.HOOK_OP == "hook_op"
        assert "hook_op" in [t.value for t in WebhookType]

    def test_enum_has_only_two_types(self):
        assert len(WebhookType) == 2
        assert set(WebhookType) == {WebhookType.AGENT_HOOK, WebhookType.HOOK_OP}


class TestRelationshipSync:
    """Tests for relationship sync payloads."""

    def test_child_relationship_create(self):
        """Test creating a child relationship."""
        payload = HookOpPayload(
            resource_type="relationship",
            type="child",
            id="child:task:task-1:agentic_process:proc-1",
            operation="create",
            data={
                "from_ref": {"id": "task-1", "type": "task"},
                "to_ref": {"id": "proc-1", "type": "agentic_process"},
            },
        )
        assert payload.resource_type == ResourceType.RELATIONSHIP
        assert payload.type == RelationshipType.CHILD
        assert payload.operation == SyncOperation.CREATE
        assert payload.is_relationship
        assert not payload.is_entity
        assert not payload.is_event

    def test_relationship_validation_rejects_invalid_type(self):
        """Test that invalid relationship types are rejected."""
        with pytest.raises(ValidationError, match="Invalid relationship type"):
            HookOpPayload(
                resource_type="relationship",
                type="invalid_relationship_type",
                id="rel-1",
                operation="create",
                data={
                    "from_ref": {"id": "task-1", "type": "task"},
                    "to_ref": {"id": "proc-1", "type": "agentic_process"},
                },
            )

    def test_entity_validation_rejects_invalid_type(self):
        """Test that invalid entity types are rejected."""
        with pytest.raises(ValidationError, match="Invalid entity type"):
            HookOpPayload(
                resource_type="entity",
                type="invalid_entity_type",
                id="entity-1",
                operation="create",
                data={},
            )

    def test_relationship_defaults_to_entity(self):
        """Test that resource_type defaults to ENTITY."""
        payload = HookOpPayload(
            type="task",
            id="task-1",
            operation="create",
            data={},
        )
        assert payload.resource_type == ResourceType.ENTITY
        assert payload.is_entity
        assert not payload.is_relationship
