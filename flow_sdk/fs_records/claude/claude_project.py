"""ClaudeProjectFsRecord — represents a Claude Code project directory.

Two discovery sources are merged automatically via the base Record hooks:

1. ``records_root/project/`` — projects created via the API (POST /graph/project)
2. ``~/.claude/projects/<encoded-path>/`` — projects opened by Claude CLI

Both sources are surfaced by ``discover()`` / ``discover_iter()`` with id-based dedup,
counted by ``discovery_items_count()`` for accurate progress-bar totals, and looked up
O(1) by ``discover_one()``.
"""

from __future__ import annotations

from pathlib import Path
from typing import ClassVar

from flow_sdk.fs_store import Record, RecordType
from .claude_session import ClaudeSessionRecord

_CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"


class ClaudeProjectFsRecord(Record):
    """A Claude Code project — a working directory with associated sessions.

    Backed by either ``records_root/project/`` (API-created) or
    ``~/.claude/projects/<encoded-cwd>/`` (Claude CLI-created).
    """

    _record_type: ClassVar[str] = RecordType.PROJECT
    _indexed_by_default: ClassVar[bool] = True

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.PROJECT
        super().__init__(**kwargs)
        encoded_path = self.data.get("encoded_path", "")
        if encoded_path:
            self.id = encoded_path
            if not self.name:
                self.name = self.data.get("real_path", "") or encoded_path
            # External-source records (from ~/.claude/projects/) are read-only;
            # records_root records (API-created, no encoded_path) are writable.
            from flow_sdk.fs_store.fs_ref import FSRef
            object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @property
    def search_title(self) -> str | None:
        return self.name or None

    @property
    def search_description(self) -> str | None:
        return self.data.get("real_path") or None

    @property
    def sessions(self) -> list[ClaudeSessionRecord]:
        """Return all sessions in this project as ``ClaudeSessionRecord``."""
        project_dir = Path(self.path or self.source_file) if (self.path or self.source_file) else None
        if not project_dir or not project_dir.is_dir():
            return []
        return [
            ClaudeSessionRecord.from_jsonl(f)
            for f in sorted(project_dir.glob("*.jsonl"))
        ]

    # -- External source: ~/.claude/projects/ --

    @classmethod
    def _external_source_iter(cls, limit: int | None = None):
        """Yield projects discovered from ``~/.claude/projects/``."""
        projects_dir = _CLAUDE_PROJECTS_DIR
        if not projects_dir.is_dir():
            return
        count = 0
        for d in sorted(projects_dir.iterdir()):
            if not d.is_dir():
                continue
            encoded = d.name
            real = "/" + encoded.lstrip("-").replace("-", "/")
            session_count = sum(1 for f in d.glob("*.jsonl"))
            yield cls(encoded_path=encoded, real_path=real,
                      session_count=session_count, path=str(d))
            count += 1
            if limit is not None and count >= limit:
                return

    @classmethod
    def _external_source_count(cls, limit: int | None = None) -> int:
        projects_dir = _CLAUDE_PROJECTS_DIR
        if not projects_dir.is_dir():
            return 0
        count = sum(1 for d in projects_dir.iterdir() if d.is_dir())
        return min(count, limit) if limit is not None else count

    @classmethod
    def _external_source_find_one(cls, uid: str) -> ClaudeProjectFsRecord | None:
        """O(1): the uid for Claude-projects is the encoded directory name."""
        candidate = _CLAUDE_PROJECTS_DIR / uid
        if not candidate.is_dir():
            return None
        real = "/" + uid.lstrip("-").replace("-", "/")
        session_count = sum(1 for f in candidate.glob("*.jsonl"))
        return cls(encoded_path=uid, real_path=real,
                   session_count=session_count, path=str(candidate))
