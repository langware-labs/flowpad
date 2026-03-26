"""Task resource types for analysis lifecycle events."""

from __future__ import annotations

from flow_sdk._compat import StrEnum
from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class TaskStatus(StrEnum):
    TO_DO = "to_do"
    IN_PROGRESS = "in_progress"
    DONE = "done"


class TaskType(StrEnum):
    TASK = "Task"
    ANALYSIS = "analysis"
    SKILL_CREATION = "skill_creation"


class TaskResource(Record):
    """A task record backed by Record."""

    _record_type: ClassVar[str] = RecordType.TASK
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    index_fields: ClassVar[list[str]] = ["description", "objective"]

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.TASK)
        kwargs.setdefault("status", TaskStatus.TO_DO)
        kwargs.setdefault("task_type", TaskType.TASK)
        super().__init__(**kwargs)

    @property
    def search_title(self) -> str | None:
        return self.name or None

    @property
    def search_description(self) -> str | None:
        return getattr(self, "objective", None) or None

    @property
    def search_content(self) -> str | None:
        val = getattr(self, "description", None)
        return str(val) if val else None

    def save_to(self, session_dir: Path) -> None:
        """Save this task into the unified session record at session_dir/record.json."""
        record_path = session_dir / "record.json"
        session = Record.init_record(record_path)
        session["task"] = self.meta_dict()
        session.save()
