from datetime import datetime
from flow_sdk._compat import StrEnum
from typing import Any, ClassVar, Dict, List, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


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
    title: str = APIField()
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
    links: Optional[Dict[str, str]] = APIField(None)
    metadata: Optional[Dict[str, Any]] = APIField(None)
    spec_id: Optional[str] = APIField(None)
    shared_by_id: Optional[str] = APIField(None)
    conversation: Optional[str] = APIField(None)
    _api_visible: ClassVar[bool] = True
