"""AgenticProcessRecord -- filesystem record for tracking processor lifecycle."""

from __future__ import annotations

import json
from typing import Any, ClassVar, TYPE_CHECKING

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.property_record import PropertyRecord
from flow_sdk.fs_records.agent_status import AgenticProcessStatus
from flow_sdk.fs_records.agentic_process_lifecycle import AgenticProcessLifecycleStatus

if TYPE_CHECKING:
    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord


def _read_queue(record) -> dict:
    """Read queue.json from record_data_dir, returning default if missing."""
    rdd = record.record_data_dir
    if rdd is None:
        return {"enabled": True, "entries": []}
    from flow_sdk.fs_store.fs_ref import FSRef
    queue_ref = FSRef(rdd / "queue.json")
    if queue_ref.exists():
        try:
            return json.loads(queue_ref.read())
        except Exception:
            pass
    return {"enabled": True, "entries": []}


def _check_session_active(record) -> bool:
    """Check if the linked Claude session is still active (JSONL mtime within 5 min)."""
    session = record.claude_session_record
    return bool(session and session.is_active)


class AgenticProcessRecord(Record):
    _record_type: ClassVar[str] = RecordType.AGENTIC_PROCESS
    _indexed_by_default: ClassVar[bool] = False
    _record_ttl: ClassVar[float] = 30.0
    is_active: bool = PropertyRecord(ttl=30, discovery=_check_session_active)
    queue: dict = PropertyRecord(ttl=5, discovery=_read_queue)

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.AGENTIC_PROCESS)
        kwargs.setdefault("status", AgenticProcessLifecycleStatus.NEW)
        # Migrate old field names from pre-existing records on disk
        if "pty_session_id" in kwargs and "pty_pid" not in kwargs:
            kwargs["pty_pid"] = kwargs.pop("pty_session_id")
        kwargs.setdefault("pty_pid", None)
        kwargs.setdefault("shell_id", None)
        kwargs.setdefault("project_encoded_name", None)
        kwargs.setdefault("project_id", None)
        super().__init__(**kwargs)

    @property
    def project_encoded_name(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("project_encoded_name")

    @project_encoded_name.setter
    def project_encoded_name(self, value: str | None) -> None:
        object.__getattribute__(self, "__dict__")["project_encoded_name"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("project_encoded_name")

    @property
    def project_id(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("project_id")

    @project_id.setter
    def project_id(self, value: str | None) -> None:
        object.__getattribute__(self, "__dict__")["project_id"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("project_id")

    @property
    def description(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("description")

    @description.setter
    def description(self, value: str | None) -> None:
        object.__getattribute__(self, "__dict__")["description"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("description")

    @property
    def instruction(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("instruction")

    @instruction.setter
    def instruction(self, value: str | None) -> None:
        object.__getattribute__(self, "__dict__")["instruction"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("instruction")

    @property
    def pty_pid(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("pty_pid")

    @pty_pid.setter
    def pty_pid(self, value: str | None) -> None:
        object.__getattribute__(self, "__dict__")["pty_pid"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("pty_pid")

    @property
    def shell_id(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("shell_id")

    @shell_id.setter
    def shell_id(self, value: str | None) -> None:
        object.__getattribute__(self, "__dict__")["shell_id"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("shell_id")

    @property
    def worker_session_id(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("worker_session_id")

    @worker_session_id.setter
    def worker_session_id(self, value: str | None) -> None:
        object.__getattribute__(self, "__dict__")["worker_session_id"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("worker_session_id")

    @property
    def search_title(self) -> str | None:
        return self.name or None

    @property
    def search_description(self) -> str | None:
        return self.description or None

    @property
    def search_content(self) -> str | None:
        val = self.instruction
        return str(val) if val else None

    @property
    def claude_session_record(self) -> ClaudeSessionRecord | None:
        """Return the linked ClaudeSessionRecord, or None if not found."""
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
        sid = self.worker_session_id
        return ClaudeSessionRecord.discover_one(sid) if sid else None

    def discover_worker_status(self, worker_session_id: str | None = None) -> AgenticProcessStatus:
        """Derive worker_status from the Claude session transcript (tail-read, ~60µs)."""
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

        sid = worker_session_id or self.worker_session_id
        if not sid:
            return AgenticProcessStatus.IDLE

        session = (
            self.claude_session_record
            if not worker_session_id
            else ClaudeSessionRecord.discover_one(worker_session_id)
        )
        return session.status if session else AgenticProcessStatus.IDLE

    def discover_status(self, worker_session_id: str | None = None) -> AgenticProcessStatus:
        """Backward-compatible alias for transcript-derived worker_status."""
        return self.discover_worker_status(worker_session_id)

    def getChildrenByType(self, type_name: str) -> list[Record]:
        """Find child records linked via RelationshipRecord."""
        from .relationship import RelationshipRecord

        if self.record_dir is None:
            return []
        rels = RelationshipRecord.discover(self.record_dir.parent)
        children = []
        for rel in rels:
            from_ref = rel.data.get("from_ref")
            to_ref = rel.data.get("to_ref")
            if (
                from_ref
                and hasattr(from_ref, "id")
                and from_ref.id == self.id
                and to_ref
                and hasattr(to_ref, "type")
                and to_ref.type == type_name
            ):
                if to_ref.path:
                    child = Record.load_record(to_ref.path)
                    children.append(child)
        return children

    def getParentsByType(self, type_name: str) -> list[Record]:
        """Find parent records linked via RelationshipRecord."""
        from .relationship import RelationshipRecord

        if self.record_dir is None:
            return []
        rels = RelationshipRecord.discover(self.record_dir.parent)
        parents = []
        for rel in rels:
            from_ref = rel.data.get("from_ref")
            to_ref = rel.data.get("to_ref")
            if (
                to_ref
                and hasattr(to_ref, "id")
                and to_ref.id == self.id
                and from_ref
                and hasattr(from_ref, "type")
                and from_ref.type == type_name
            ):
                if from_ref.path:
                    parent = Record.load_record(from_ref.path)
                    parents.append(parent)
        return parents
