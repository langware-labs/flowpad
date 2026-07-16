from datetime import datetime
from typing import Any, List, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.builtin.git_origin import GitOrigin
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


class TaskKind(StrEnum):
    STANDARD = "standard"
    GROUP = "group"


class Task(Entity):
    type: str = APIField(default="task")
    title: str = APIField("")
    # Task is a folder-backed markdown asset (see task_type_info): asset_ref is
    # the ``tasks/<name>/`` folder holding ``task.md`` + inner ``spec.md``.
    asset_ref: Optional[str] = APIField(None)
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
    # Group tasks: ``group`` = the overview task that owns one child ("member
    # task") per contacts-group member; children stay ``standard``.
    kind: str = APIField(TaskKind.STANDARD)
    # Name of the contacts group a ``group`` task was assigned to — shown as
    # "Owner: <group_name>" on the overview task. Stamped by create-group-task.
    group_name: Optional[str] = APIField(None)
    # Group-task parent pointer; "" = top-level. Children own only their
    # status — every display field resolves from the parent at render time.
    parent_id: str = APIField("")
    # The member's deliverable (repo / PR / doc / app URL). Unlike
    # ``git_origin`` this rides hub reflection, so it reaches the owner.
    submission_url: Optional[str] = APIField(None)
    priority: Optional[str] = APIField(None)
    tags: List[str] = APIField([])
    shared_by_id: Optional[str] = APIField(None)
    spec_type: Optional[str] = APIField(None)
    my_process_id: Optional[str] = APIField(None)
    shared_process_id: Optional[str] = APIField(None)
    # NOTE: spec_id, conversation_id, links — moved into the unified
    # ``context_entities`` list on the base ``Entity``. Read via
    # ``task.first_context_of_type('spec')`` / ``task.first_context_of_type('conversation')``;
    # mutate via ``task.add_context_entity(...)`` / ``task.remove_context_entity(...)``.

    # Promoted from former `metadata` blob — first-class fields.
    active_form: Optional[str] = APIField(None)
    analysis_json_path: Optional[str] = APIField(None)
    analysis_path: Optional[str] = APIField(None)
    artifacts: Optional[List[Any]] = APIField(None)
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
    git_origin: Optional[GitOrigin] = APIField(None)
    recipient_email: Optional[str] = APIField(None)
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

    # NOTE: per-subclass implicit context projections (project_id /
    # assignee / my_process_id / shared_process_id) used to live here as
    # ``_direct_fields_as_typeids``. Implicit projection moved entirely to
    # the backend base (``Entity.get_implicit_private_context_entities``);
    # ``project_id`` is now projected automatically for every entity that
    # has one, so Task gets the project chip for free. The other former
    # projections (assignee / my_process_id / shared_process_id) were
    # dropped per "base returns project_id only for now". Reintroduce them
    # by overriding ``get_implicit_private_context_entities`` on Task and
    # calling ``super()`` if there's a confirmed UX need.
