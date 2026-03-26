"""Models for hook_op webhook payloads — unified CRUD + event + invoke + log dispatch."""

from flow_sdk._compat import StrEnum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, model_validator


class SyncOperation(StrEnum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    EVENT = "event"
    INVOKE = "invoke"
    LOG = "log"


class ResourceType(StrEnum):
    """Type of resource being synced - entity or relationship."""

    ENTITY = "entity"
    RELATIONSHIP = "relationship"


class RecordType(StrEnum):
    """Valid entity types for hook_op."""

    TASK = "task"
    SKILL = "skill"
    LOG = "log"
    RULE = "rule"
    AGENTIC_PROCESS = "agentic_process"
    BOOKMARK = "bookmark"
    SESSION_ANALYSIS = "session_analysis"


class RelationshipType(StrEnum):
    """Valid relationship types for hook_op."""

    CHILD = "child"
    PARENT = "parent"
    DEPENDS_ON = "depends_on"
    RELATED_TO = "related_to"


class RefType(StrEnum):
    DATA = "data"
    PATH = "path"


class ExecutionScopeEntry(BaseModel):
    type: str
    id: str


class HookOpPayload(BaseModel):
    resource_type: ResourceType = ResourceType.ENTITY
    type: str  # RecordType for entities, RelationshipType for relationships
    id: str
    operation: SyncOperation
    ref_type: RefType = RefType.DATA
    data: Dict[str, Any] = Field(default_factory=dict)
    execution_scope: List[ExecutionScopeEntry] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_payload(self) -> "HookOpPayload":
        # Validate EVENT operations have event_name
        if self.operation == SyncOperation.EVENT and "event_name" not in self.data:
            raise ValueError("EVENT operations must include 'event_name' in data")

        # Validate entity types (skip for INVOKE and LOG which may have arbitrary types)
        if self.operation not in (SyncOperation.INVOKE, SyncOperation.LOG):
            if self.resource_type == ResourceType.ENTITY:
                valid_types = [t.value for t in RecordType]
                if self.type not in valid_types:
                    raise ValueError(f"Invalid entity type '{self.type}'. Must be one of: {valid_types}")

            elif self.resource_type == ResourceType.RELATIONSHIP:
                valid_types = [t.value for t in RelationshipType]
                if self.type not in valid_types:
                    raise ValueError(f"Invalid relationship type '{self.type}'. Must be one of: {valid_types}")

        return self

    @property
    def is_event(self) -> bool:
        return self.operation == SyncOperation.EVENT

    @property
    def is_entity(self) -> bool:
        return self.resource_type == ResourceType.ENTITY

    @property
    def is_relationship(self) -> bool:
        return self.resource_type == ResourceType.RELATIONSHIP

    @property
    def event_name(self) -> Optional[str]:
        return self.data.get("event_name")

    @property
    def event_data(self) -> Optional[Dict[str, Any]]:
        return self.data.get("event_data")


# Backward-compat alias
ResourceSyncPayload = HookOpPayload
