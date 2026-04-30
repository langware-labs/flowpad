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
    links: Optional[Dict[str, str]] = APIField(None)
    spec_id: Optional[str] = APIField(None)
    shared_by_id: Optional[str] = APIField(None)
    conversation_id: Optional[str] = APIField(None)
    project_id: Optional[str] = APIField(None)
    spec_type: Optional[str] = APIField(None)
    my_process_id: Optional[str] = APIField(None)
    shared_process_id: Optional[str] = APIField(None)
    remote_project_id: Optional[str] = APIField(None)
    remote_project_name: Optional[str] = APIField(None)

    # Promoted from former `metadata` blob — first-class fields.
    active_form: Optional[str] = APIField(None)
    analysis_json_path: Optional[str] = APIField(None)
    analysis_path: Optional[str] = APIField(None)
    artifacts: Optional[List[Any]] = APIField(None)
    branch: Optional[str] = APIField(None)
    classification_category: Optional[str] = APIField(None)
    classification_command: Optional[str] = APIField(None)
    classification_path: Optional[str] = APIField(None)
    classification_title: Optional[str] = APIField(None)
    command: Optional[str] = APIField(None)
    completed_at: Optional[datetime] = APIField(None)
    error_fingerprint: Optional[str] = APIField(None)
    folder_name: Optional[str] = APIField(None)
    output_dir: Optional[str] = APIField(None)
    process_id: Optional[str] = APIField(None)
    project_name: Optional[str] = APIField(None)
    project_root: Optional[str] = APIField(None)
    project_url: Optional[str] = APIField(None)
    recipient_email: Optional[str] = APIField(None)
    repo_id: Optional[str] = APIField(None)
    result_uname: Optional[str] = APIField(None)
    sender_email: Optional[str] = APIField(None)
    sender_name: Optional[str] = APIField(None)
    session_id: Optional[str] = APIField(None)
    skill_name: Optional[str] = APIField(None)
    skill_path: Optional[str] = APIField(None)
    skill_scope: Optional[str] = APIField(None)
    task_type_label: Optional[str] = APIField(None)
    team_space_id: Optional[str] = APIField(None)
    worker_session_id: Optional[str] = APIField(None)

    _api_visible: ClassVar[bool] = True
