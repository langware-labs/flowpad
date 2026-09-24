"""Filesystem contracts independent of application entities."""
from datetime import datetime
from typing import Any, ClassVar, List, Optional

from pydantic import Field

from flow_sdk._compat import StrEnum
from flow_sdk.fs_store.origin.field import OriginField
from flow_sdk.schema.data_spec import FrontMatter
from flow_sdk.schema.data_spec.io.native import Text


class TaskEventType(StrEnum):
    TASK_CREATED = "task_created"
    TASK_UPDATED = "task_updated"


class TaskStatus(StrEnum):
    TO_DO = "to_do"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    # A delegated task's lifecycle (the task ledger, ``flow_sdk/tasks``) — A2A's task states.
    SUBMITTED = "submitted"
    WORKING = "working"
    INPUT_REQUIRED = "input_required"
    FAILED = "failed"
    CANCELED = "canceled"


#: Where each status sits on the three-bucket board every task surface shows.
STATUS_FAMILY = {
    TaskStatus.TO_DO: TaskStatus.TO_DO,
    TaskStatus.SUBMITTED: TaskStatus.TO_DO,
    TaskStatus.IN_PROGRESS: TaskStatus.IN_PROGRESS,
    TaskStatus.WORKING: TaskStatus.IN_PROGRESS,
    TaskStatus.INPUT_REQUIRED: TaskStatus.IN_PROGRESS,
    TaskStatus.DONE: TaskStatus.DONE,
    TaskStatus.FAILED: TaskStatus.DONE,
    TaskStatus.CANCELED: TaskStatus.DONE,
}
#: Statuses a task does not leave.
TERMINAL_STATUSES = frozenset({TaskStatus.DONE, TaskStatus.FAILED, TaskStatus.CANCELED})


def status_family(status: str | None) -> str:
    """``to_do`` / ``in_progress`` / ``done`` for any status — an unknown one reads as to do."""
    try:
        return STATUS_FAMILY[TaskStatus(str(status or ""))].value
    except ValueError:
        return TaskStatus.TO_DO.value


class TaskType(StrEnum):
    TASK = "Task"
    ANALYSIS = "analysis"
    SKILL_CREATION = "skill_creation"


class TaskKind(StrEnum):
    STANDARD = "standard"
    GROUP = "group"


class TaskSpec(FrontMatter):
    """``tasks/<name>/task.md`` — the shape of the document, and therefore the
    SHARE whitelist: sharing copies the folder verbatim, and sender-local keys
    (``my_process_id`` / ``project_root`` / ``project_id`` / ``project_name``)
    are absent from this class, so a received task is runnable and maps its
    own local project. ``description`` is the markdown ``Body``; ``title``
    falls back to the folder (``derive_task``)."""

    main_file: ClassVar[str | None] = "task.md"

    title: Optional[str] = None
    status: Optional[str] = None
    task_type: Optional[str] = None
    kind: Optional[str] = None
    parent_id: Optional[str] = ""
    assignee: Optional[str] = None
    priority: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    due_at: Optional[datetime] = None
    start_date: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    archived_at: Optional[datetime] = None
    spec_type: Optional[str] = None
    shared_by_id: Optional[str] = None
    shared_process_id: Optional[str] = None
    active_form: Optional[str] = None
    analysis_json_path: Optional[str] = None
    analysis_path: Optional[str] = None
    artifacts: Optional[List[Any]] = None
    origin: OriginField = None
    classification_category: Optional[str] = None
    classification_command: Optional[str] = None
    classification_path: Optional[str] = None
    classification_title: Optional[str] = None
    command: Optional[str] = None
    error_fingerprint: Optional[str] = None
    folder_name: Optional[str] = None
    output_dir: Optional[str] = None
    process_id: Optional[str] = None
    recipient_email: Optional[str] = None
    result_uname: Optional[str] = None
    sender_email: Optional[str] = None
    sender_name: Optional[str] = None
    session_id: Optional[str] = None
    skill_name: Optional[str] = None
    skill_path: Optional[str] = None
    skill_scope: Optional[str] = None
    task_type_label: Optional[str] = None
    team_space_id: Optional[str] = None
    worker_session_id: Optional[str] = None
    # ── a delegated task (the task ledger) ──
    creator: Optional[str] = None
    owner: Optional[str] = None
    origin_conversation: Optional[str] = None
    origin_session: Optional[str] = None
    budget_usd: Optional[float] = None
    budget_turns: Optional[int] = None
    cost_usd: Optional[float] = None
    result: Optional[str] = None
    description: Text = ""
