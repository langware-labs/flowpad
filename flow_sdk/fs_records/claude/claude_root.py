"""ClaudeRootFsRecord — the root of all Claude Code projects.

Represents ``~/.claude/projects/`` and provides access to all projects
and sessions across the entire Claude installation.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

from flow_sdk.fs_store import Record, RecordType
from .claude_session import ClaudeSessionRecord

if TYPE_CHECKING:
    from .claude_project import ClaudeProjectFsRecord

def _default_projects_dir() -> Path:
    """Per-instance ~/.claude/projects (call-time, via InstanceSettings)."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    return get_instance_settings().claude_projects_dir


class ClaudeRootFsRecord(Record):
    """Root record for the Claude Code installation.

    Children are ``ClaudeProjectFsRecord`` instances (one per project dir).
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_ROOT

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_ROOT
        if "projects_dir" not in kwargs:
            kwargs["projects_dir"] = str(_default_projects_dir())
        super().__init__(**kwargs)
        if not self.name:
            self.name = "claude_root"
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @property
    def _projects_path(self) -> Path:
        return Path(self.projects_dir)

    @property
    def projects(self) -> list[ClaudeProjectFsRecord]:
        """Return all project directories as ``ClaudeProjectFsRecord``."""
        from .claude_project import ClaudeProjectFsRecord
        return ClaudeProjectFsRecord.discover()

    @property
    def active_sessions(self):
        """Return the active-sessions scanner."""
        from .claude_active_sessions import ClaudeActiveSessionsFsRecord
        return ClaudeActiveSessionsFsRecord.default()

    @property
    def history(self):
        """Return the global prompt history record."""
        from .claude_history import ClaudeHistoryFsRecord
        return ClaudeHistoryFsRecord.default()

    def get_session(self, session_id: str) -> ClaudeSessionRecord | None:
        """Find a session by ID across all projects.

        Returns a ``ClaudeSessionRecord`` or ``None``.
        """
        if not self._projects_path.is_dir():
            return None
        for project_dir in self._projects_path.iterdir():
            if not project_dir.is_dir():
                continue
            jsonl = project_dir / f"{session_id}.jsonl"
            if jsonl.is_file():
                return ClaudeSessionRecord.from_jsonl(jsonl)
        return None

    @classmethod
    def default(cls) -> ClaudeRootFsRecord:
        """Return the root record for the default Claude installation."""
        return cls(projects_dir=str(_default_projects_dir()))
