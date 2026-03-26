"""ClaudeActiveSessionFsRecord — a single active Claude Code session.

Built from ``~/.claude/projects/<project>/<uuid>.jsonl``.  A session is
"active" when its JSONL mtime is within *max_active_seconds* of now.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import ClassVar
from flow_sdk._compat import Self

from flow_sdk.fs_store import Record, RecordType

_HEAD_LINES = 20


class ClaudeActiveSessionFsRecord(Record):
    """A single currently-active Claude Code session."""

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.ACTIVE_SESSION
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))
        session_id = self.data.get("session_id", "")
        if session_id:
            self.id = session_id
            if not self.name:
                self.name = self.data.get("slug", "") or session_id

    def __repr__(self) -> str:
        label = self.data.get("slug", "") or self.data.get("cwd", "") or self.data.get("session_id", "")[:8]
        return f"ActiveSession({label}, uptime={self.data.get('uptime', '')})"

    @property
    def time_ago(self) -> str:
        """Human-friendly relative time since last activity."""
        if not self.last_active:
            return ""
        try:
            dt = datetime.fromisoformat(self.last_active)
        except ValueError:
            return ""
        seconds = int((datetime.now(tz=timezone.utc) - dt).total_seconds())
        if seconds < 60:
            return "just now"
        minutes = seconds // 60
        if minutes < 60:
            return f"{minutes}m ago"
        return f"{seconds // 3600}h ago"

    @property
    def duration(self) -> str:
        """Duration from started_at until now."""
        if not self.started_at:
            return ""
        try:
            start = datetime.fromisoformat(self.started_at)
        except ValueError:
            return ""
        return _format_duration(int((datetime.now(tz=timezone.utc) - start).total_seconds()))

    @classmethod
    def from_jsonl(cls, jsonl_path: Path, max_active_seconds: int) -> Self | None:
        """Build a record from a JSONL file if the session is active.

        Returns ``None`` when the file's mtime exceeds *max_active_seconds*.
        """
        try:
            mtime = jsonl_path.stat().st_mtime
        except OSError:
            return None

        if time.time() - mtime > max_active_seconds:
            return None

        session_id = jsonl_path.stem
        project = jsonl_path.parent.name
        last_active = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()

        # -- Read head for metadata ------------------------------------
        slug = ""
        git_branch = ""
        cwd = ""
        version = ""
        started_at = ""

        try:
            with open(jsonl_path, encoding="utf-8") as fh:
                for idx, line in enumerate(fh):
                    if idx >= _HEAD_LINES:
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        raw = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not slug:
                        slug = raw.get("slug", "")
                    if not git_branch:
                        git_branch = raw.get("gitBranch", "")
                    if not cwd:
                        cwd = raw.get("cwd", "")
                    if not version:
                        version = raw.get("version", "")
                    if not started_at:
                        ts = raw.get("timestamp")
                        if ts:
                            started_at = ts
                    if slug and git_branch and cwd and version and started_at:
                        break
        except OSError:
            return None

        # -- Fast message count ----------------------------------------
        message_count = _fast_message_count(jsonl_path)

        # -- Uptime ----------------------------------------------------
        uptime = ""
        if started_at:
            try:
                start_dt = datetime.fromisoformat(started_at)
                uptime = _format_duration(int((datetime.now(tz=timezone.utc) - start_dt).total_seconds()))
            except ValueError:
                pass

        return cls(
            session_id=session_id,
            project=project,
            cwd=cwd,
            version=version,
            git_branch=git_branch,
            started_at=started_at,
            last_active=last_active,
            jsonl_path=str(jsonl_path),
            slug=slug,
            message_count=message_count,
            uptime=uptime,
        )


def _fast_message_count(path: Path) -> int:
    """Approximate message count using byte-level search."""
    try:
        raw = path.read_bytes()
    except OSError:
        return 0
    return (
        raw.count(b'"type":"user"')
        + raw.count(b'"type": "user"')
        + raw.count(b'"type":"assistant"')
        + raw.count(b'"type": "assistant"')
    )


def _format_duration(total_seconds: int) -> str:
    """Format seconds as a human-friendly duration string."""
    if total_seconds < 0:
        total_seconds = 0
    if total_seconds < 60:
        return f"{total_seconds}s"
    minutes = total_seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    hours = minutes // 60
    rm = minutes % 60
    if hours < 24:
        return f"{hours}h {rm}m" if rm else f"{hours}h"
    days = hours // 24
    rh = hours % 24
    return f"{days}d {rh}h" if rh else f"{days}d"
