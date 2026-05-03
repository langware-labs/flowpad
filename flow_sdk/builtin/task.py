from datetime import datetime
from flow_sdk._compat import StrEnum
from typing import Any, ClassVar, Dict, List, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import TypeId


class TaskEventType(StrEnum):
    TASK_CREATED = "task_created"
    TASK_UPDATED = "task_updated"


class TaskStatus(StrEnum):
    TO_DO = "to_do"
    IN_PROGRESS = "in_progress"
    DONE = "done"


class TaskType(StrEnum):
    TASK = "Task"
    ANALYSIS = "analysis"
    SKILL_CREATION = "skill_creation"


class Task(Entity):
    type: str = APIField(default="task")
    title: str = APIField("")
    description: Optional[str] = APIField(None, blob=True)
    status: str = APIField(TaskStatus.TO_DO)
    last_viewed_at: Optional[datetime] = APIField(None)
    due_at: Optional[datetime] = APIField(None)
    archived_at: Optional[datetime] = APIField(None)
    start_date: Optional[datetime] = APIField(None)
    ttl: Optional[int] = APIField(None)
    target_entity: Optional[str] = APIField(None)
    assignee: Optional[str] = APIField(None)
    reporter: Optional[str] = APIField(None)
    workspace_id: Optional[str] = APIField(None)  # Should be a reference to organisation entity
    task_type: str = APIField(TaskType.TASK)
    priority: Optional[str] = APIField(None)
    tags: List[str] = APIField([])
    metadata: Optional[Dict[str, Any]] = APIField(None)
    shared_by_id: Optional[str] = APIField(None)
    project_id: Optional[str] = APIField(None)
    spec_type: Optional[str] = APIField(None)
    my_process_id: Optional[str] = APIField(None)
    shared_process_id: Optional[str] = APIField(None)
    remote_project_id: Optional[str] = APIField(None)
    remote_project_name: Optional[str] = APIField(None)
    # NOTE: spec_id, conversation_id, links — moved into the unified
    # ``context_entities`` list on the base ``Entity``. Read via
    # ``task.first_context_of_type('spec')`` / ``task.first_context_of_type('conversation')``;
    # mutate via ``task.add_context_entity(...)`` / ``task.remove_context_entity(...)``.
    _api_visible: ClassVar[bool] = True

    def _direct_fields_as_typeids(self) -> List[TypeId]:
        """Project chip-relevant direct fields into the merged context view."""
        out: List[TypeId] = []
        if self.project_id:
            out.append(TypeId(type="project", id=self.project_id))
        if self.assignee:
            out.append(TypeId(type="user", id=self.assignee))
        if self.my_process_id:
            out.append(TypeId(type="agentic_process", id=self.my_process_id))
        if self.shared_process_id:
            out.append(TypeId(type="agentic_process", id=self.shared_process_id))
        return out
