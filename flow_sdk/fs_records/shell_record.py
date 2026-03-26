"""ShellRecord -- filesystem record for shell session persistence.

Tracks the lifecycle of a shell session (PTY) across server restarts.
Each record represents a single shell tab and stores its PTY PID,
working directory, visibility, and status. Records are stored globally
at ~/.flow/records/shell_session/ and are used by PtySessionManager to
recover running sessions after a server restart.
"""

from __future__ import annotations

from datetime import datetime, timezone
from flow_sdk._compat import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from flow_sdk.fs_store import Record, RecordType

if TYPE_CHECKING:
    from flow_sdk.fs_store.fs_ref import BinaryFsRef
from flow_sdk.fs_store.record import get_default_records_root, record_stem


class ShellStatus(StrEnum):
    IDLE = "idle"
    RUNNING = "running"
    CLOSED = "closed"
    ELEVATED = "elevated"


# Backward-compat alias
ShellSessionStatus = ShellStatus


class ShellRecord(Record):
    """Filesystem record for a shell session.

    Persists shell session state (PTY ID, working directory, status) to disk
    so that sessions can be recovered after server restarts. Works alongside
    PtySessionManager which manages the in-memory PTY process state.
    """

    _record_type: ClassVar[str] = RecordType.SHELL_SESSION
    index_fields: ClassVar[list[str]] = ["name"]

    def __init__(self, **kwargs: Any) -> None:
        import uuid as _uuid

        if "id" not in kwargs:
            kwargs["id"] = str(_uuid.uuid4())
        kwargs.setdefault("type", RecordType.SHELL_SESSION)
        # Migrate old field names from pre-existing records on disk
        if "pty_session_id" in kwargs and "pty_pid" not in kwargs:
            kwargs["pty_pid"] = kwargs.pop("pty_session_id")
        if "process_id" in kwargs and "agentic_process_id" not in kwargs:
            kwargs["agentic_process_id"] = kwargs.pop("process_id")
        # Migrate old "state" field → "status" (must happen before setdefault)
        if "state" in kwargs and "status" not in kwargs:
            kwargs["status"] = kwargs.pop("state")
        elif "state" in kwargs:
            kwargs.pop("state")
        kwargs.setdefault("status", ShellStatus.IDLE)
        # pty_pid defaults to the record id (same UUID)
        kwargs.setdefault("pty_pid", kwargs["id"])
        kwargs.setdefault("agentic_process_id", None)
        kwargs.setdefault("workdir", None)
        kwargs.setdefault("name", None)
        kwargs.setdefault("tab_order", 0)
        kwargs.setdefault("claude_session_id", None)
        kwargs.setdefault("entity_id", None)
        kwargs.setdefault("created_at", datetime.now(timezone.utc).isoformat())
        kwargs.setdefault("last_active_at", datetime.now(timezone.utc).isoformat())
        super().__init__(**kwargs)

    def touch(self) -> None:
        object.__setattr__(self, "last_active_at", datetime.now(timezone.utc).isoformat())
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("last_active_at")
        self.save()

    @property
    def pty_stream_path(self) -> Path:
        """Path to the .pty stream file for this session."""
        pty_pid = getattr(self, "pty_pid", None) or getattr(self, "pty_session_id", None)
        if pty_pid is None:
            raise ValueError("No pty_pid set")
        stem = record_stem("shell_session", self.id)
        return get_default_records_root() / "shell_session" / stem / f"{pty_pid}.pty"

    @property
    def pty_stream_ref(self) -> "BinaryFsRef":
        """FsRef to the .pty stream file for this session."""
        from flow_sdk.fs_store.fs_ref import BinaryFsRef

        return BinaryFsRef(self.pty_stream_path, read_only=True)

    def close(self) -> None:
        """Set status to CLOSED, delete .pty file, save. Idempotent."""
        if getattr(self, "status", None) == ShellStatus.CLOSED:
            return
        object.__setattr__(self, "status", ShellStatus.CLOSED)
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("status")
        pty_pid = getattr(self, "pty_pid", None) or getattr(self, "pty_session_id", None)
        if pty_pid is not None:
            try:
                pty_path = self.pty_stream_path
                if pty_path.exists():
                    pty_path.unlink()
            except (OSError, ValueError):
                pass
        self.save()

    def elevate(self, claude_session_id: str) -> None:
        """Set status to ELEVATED and store the claude_session_id, then save."""
        object.__setattr__(self, "status", ShellStatus.ELEVATED)
        object.__setattr__(self, "claude_session_id", claude_session_id)
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("status")
        dirty.add("claude_session_id")
        self.save()

    def sync_from_entity(self, entity) -> bool:
        """Sync entity fields into record attrs."""
        metadata = entity.db_json()
        for k, v in metadata.items():
            object.__setattr__(self, k, v)
            dirty = object.__getattribute__(self, "_dirty_keys")
            dirty.add(k)
        self.save()
        return True


# Backward-compat alias
ShellSessionRecord = ShellRecord
