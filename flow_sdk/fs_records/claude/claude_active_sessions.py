"""ClaudeActiveSessionsFsRecord — container for all active Claude Code sessions.

Scans ``~/.claude/projects/`` for JSONL transcripts with recent mtime.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import ClassVar
from flow_sdk._compat import Self

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.utils.claude_paths import get_user_home_path

from .claude_active_session import ClaudeActiveSessionFsRecord

_DEFAULT_MAX_ACTIVE_SECONDS = 300  # 5 minutes


class ClaudeActiveSessionsFsRecord(Record):
    """Container that scans for all currently-active Claude Code sessions."""

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.ACTIVE_SESSIONS
        if "projects_dir" not in kwargs:
            kwargs["projects_dir"] = str(get_user_home_path() / ".claude" / "projects")
        if "max_active_seconds" not in kwargs:
            kwargs["max_active_seconds"] = _DEFAULT_MAX_ACTIVE_SECONDS
        if "scan_time_ms" not in kwargs:
            kwargs["scan_time_ms"] = 0.0
        super().__init__(**kwargs)
        if not self.name:
            self.name = "active_sessions"
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @property
    def entries(self) -> list[ClaudeActiveSessionFsRecord]:
        """Scan projects dir and return active sessions (most recent first)."""
        t0 = time.perf_counter()
        pdir = Path(self.projects_dir)
        if not pdir.is_dir():
            self.scan_time_ms = (time.perf_counter() - t0) * 1000
            return []

        results: list[ClaudeActiveSessionFsRecord] = []
        for jsonl in pdir.glob("*/*.jsonl"):
            entry = ClaudeActiveSessionFsRecord.from_jsonl(
                jsonl, self.max_active_seconds,
            )
            if entry is not None:
                results.append(entry)

        results.sort(key=lambda e: e.last_active, reverse=True)
        self.scan_time_ms = (time.perf_counter() - t0) * 1000
        return results

    @classmethod
    def default(cls, max_active_seconds: int = _DEFAULT_MAX_ACTIVE_SECONDS) -> Self:
        """Return a record pointing at the default projects directory."""
        return cls(max_active_seconds=max_active_seconds)

    @classmethod
    def scan(cls, max_active_seconds: int = _DEFAULT_MAX_ACTIVE_SECONDS) -> Self:
        """Convenience: create, trigger the scan, and return self."""
        instance = cls.default(max_active_seconds=max_active_seconds)
        _ = instance.entries
        return instance
