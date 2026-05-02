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


def _unwrap_task_envelope(data: Any) -> dict:
    """Some manifest.json files wrap the task fields under a ``data`` key
    (legacy/external format). Unwrap when present so callers see flat fields."""
    if isinstance(data, dict) and isinstance(data.get("data"), dict) and (
        "id" in data["data"] or "task_id" in data["data"]
    ):
        return data["data"]
    return data if isinstance(data, dict) else {}


class TaskResource(Record):
    """A task record backed by Record."""

    _record_type: ClassVar[str] = RecordType.TASK
    _indexed_by_default: ClassVar[bool] = True
    _browseable: ClassVar[bool] = True
    _creatable: ClassVar[bool] = True
    _icon: ClassVar[str] = "CheckSquare"
    index_fields: ClassVar[list[str]] = ["description", "objective"]

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.TASK)
        kwargs.setdefault("status", TaskStatus.TO_DO)
        kwargs.setdefault("task_type", TaskType.TASK)
        super().__init__(**kwargs)

    @classmethod
    async def from_fsref(cls, ref) -> list["TaskResource"]:
        """Indexer entry point — parse `<task_dir>/manifest.json` into a TaskResource.

        Task id lives inside the JSON (`task_id` field), not in the directory
        name. FSIndexer is the canonical scan path.
        """
        import json
        manifest = ref._path
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []
        data = _unwrap_task_envelope(data)
        task_id = data.get("task_id") or data.get("id")
        if not task_id:
            return []
        name = data.get("title") or data.get("name") or manifest.parent.name
        status = data.get("status") or TaskStatus.TO_DO
        kwargs: dict[str, Any] = {"id": task_id, "name": name, "status": status}
        for key in ("description", "objective", "task_type"):
            if key in data:
                kwargs[key] = data[key]
        rec = cls(**kwargs)
        rec.source_file = str(manifest)
        return [rec]

    @classmethod
    def getId(cls, ref) -> str:
        """Id = `task_id` field inside manifest.json.

        Matches `from_fsref` which constructs the record with `id=task_id`.
        Falls back to the parent directory name when manifest is unreadable."""
        import json
        try:
            data = json.loads(ref._path.read_text(encoding="utf-8"))
            data = _unwrap_task_envelope(data)
            return str(data.get("task_id") or data.get("id") or ref._path.parent.name)
        except (json.JSONDecodeError, OSError):
            return ref._path.parent.name

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
        session = Record.load_record(record_path)
        session["task"] = self.meta_dict()
        session.save()
