"""AgenticProcessRecord -- filesystem record for tracking processor lifecycle."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, ClassVar, TYPE_CHECKING

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.property_record import PropertyRecord
from flow_sdk.fs_records.agent_status import WorkerStatus
from flow_sdk.fs_records.agentic_process_lifecycle import ProcessStatus

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

    # `project_encoded_name` is a legacy denormalized field that disagreed
    # with `project_id` whenever the binding moved (see 4c5bd6e4 incident).
    # AgenticProcess uses `project_id` as the single source of truth; the
    # encoded directory name is derived from the bound Project on demand.
    # Stripped on both construction (__init__) and on-disk hydrate
    # (from_dict) so stale values fall off the record the next time it saves.
    _LEGACY_KEYS: ClassVar[frozenset[str]] = frozenset({"project_encoded_name"})

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.AGENTIC_PROCESS)
        kwargs.setdefault("status", ProcessStatus.NEW)
        # Migrate old field names from pre-existing records on disk
        if "pty_session_id" in kwargs and "pty_pid" not in kwargs:
            kwargs["pty_pid"] = kwargs.pop("pty_session_id")
        kwargs.setdefault("pty_pid", None)
        kwargs.setdefault("shell_id", None)
        kwargs.setdefault("project_id", None)
        for key in self._LEGACY_KEYS:
            kwargs.pop(key, None)
        super().__init__(**kwargs)

    @classmethod
    def from_dict(cls, data: dict) -> "AgenticProcessRecord":
        # ``Record.from_dict`` bypasses ``__init__`` (uses ``cls.__new__`` +
        # direct ``__dict__`` writes), so strip legacy keys here too — the
        # on-disk hydrate path is the one that needs the cleanup.
        if any(k in data for k in cls._LEGACY_KEYS):
            data = {k: v for k, v in data.items() if k not in cls._LEGACY_KEYS}
        return super().from_dict(data)  # type: ignore[return-value]

    # ── Execution-folder layout ──────────────────────────────────────────────
    # Per-process artifacts live under `<record_dir>/execution/{input,output,assets}/`.
    # `_dir` getters return Path (auto-mkdir; override the Record-base layout so
    # input/output/assets sit under execution/); `_folder` getters return FSRef
    # wrappers for UI / wire use.

    @property
    def exe_folder(self) -> FSRef | None:
        rd = self.record_dir
        if rd is None:
            return None
        p = Path(rd) / "execution"
        p.mkdir(parents=True, exist_ok=True)
        return FSRef(p)

    @property
    def input_dir(self) -> Path:
        rd = self.record_dir
        if rd is None:
            raise ValueError("No record_dir set")
        p = Path(rd) / "execution" / "input"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def output_dir(self) -> Path:
        rd = self.record_dir
        if rd is None:
            raise ValueError("No record_dir set")
        p = Path(rd) / "execution" / "output"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def assets_dir(self) -> Path:
        rd = self.record_dir
        if rd is None:
            raise ValueError("No record_dir set")
        p = Path(rd) / "execution" / "assets"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def input_folder(self) -> FSRef | None:
        return FSRef(self.input_dir) if self.record_dir is not None else None

    @property
    def output_folder(self) -> FSRef | None:
        return FSRef(self.output_dir) if self.record_dir is not None else None

    @property
    def assets_folder(self) -> FSRef | None:
        return FSRef(self.assets_dir) if self.record_dir is not None else None

    @property
    def total_cost_usd(self) -> float | None:
        """USD cost of this process's session transcript so far.

        Derives from the on-disk JSONL via
        ``transcript_analyzer.pricing.total_cost_usd`` — no entity-side
        storage; we recompute on every read. Cheap because the per-message
        usage parser only touches each JSONL line once and we don't keep
        the full entry list. Returns None if no session_id is known yet.
        """
        sid = (
            object.__getattribute__(self, "__dict__").get("session_id")
            or getattr(self, "session_id", None)
        )
        if not sid:
            return None
        worker_type = object.__getattribute__(self, "__dict__").get("worker_type") or "claude"
        from flow_sdk.transcript_analyzer.pricing import total_cost_usd as _total
        from flow_sdk.transcript_analyzer.resolver import (
            resolve_session_jsonl,
            TranscriptNotFoundError,
        )
        try:
            path = resolve_session_jsonl(str(worker_type), str(sid))
        except (TranscriptNotFoundError, ValueError):
            return None
        return _total(str(worker_type), path)

    def meta_dict(self) -> dict:
        """Inject the per-process execution folder refs onto the Entity row.

        The record-side getters compute paths from record_dir; Entity consumers
        want them as serialized FSRef dicts (matching the wire format the TS
        side already expects via `FSRef.fromJson`).
        """
        result = super().meta_dict()
        type_id = "compute_node-@local"
        for attr in ("exe_folder", "input_folder", "output_folder", "assets_folder"):
            ref = getattr(self, attr, None)
            if ref is not None:
                result[attr] = ref.to_dict(type_id=type_id)
        # Cost (derived from session jsonl). Float, None if no session yet.
        try:
            cost = self.total_cost_usd
            if cost is not None:
                result["total_cost_usd"] = cost
        except Exception:
            # Never break entity serialization over a transcript-read failure.
            pass
        return result

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
        return ClaudeSessionRecord.get(sid) if sid else None

    def discover_worker_status(self, worker_session_id: str | None = None) -> WorkerStatus:
        """Derive worker_status from the Claude session transcript (tail-read, ~60µs)."""
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

        sid = worker_session_id or self.worker_session_id
        if not sid:
            return WorkerStatus.IDLE

        session = (
            self.claude_session_record
            if not worker_session_id
            else ClaudeSessionRecord.get(worker_session_id)
        )
        return session.status if session else WorkerStatus.IDLE

    def discover_status(self, worker_session_id: str | None = None) -> WorkerStatus:
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
