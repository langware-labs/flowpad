"""ClaudeHistoryEntryFsRecord — a single prompt from ~/.claude/history.jsonl."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, ClassVar
from flow_sdk._compat import Self

from flow_sdk.fs_store import Record, RecordRef, RecordType

if TYPE_CHECKING:
    from .claude_session import ClaudeSessionRecord


class ClaudeHistoryEntryFsRecord(Record):
    """One prompt entry from the global Claude Code history."""

    _record_type: ClassVar[str] = RecordType.HISTORY_ENTRY

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.HISTORY_ENTRY
        super().__init__(**kwargs)
        if not self.name:
            display = self.data.get("display", "")
            self.name = display[:80] if display else ""
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    def __repr__(self) -> str:
        display = self.data.get("display", "")
        return f"ClaudeHistoryEntryFsRecord: {display[:80]}"

    @property
    def timestamp_dt(self) -> datetime | None:
        if not self.timestamp_ms:
            return None
        return datetime.fromtimestamp(self.timestamp_ms / 1000, tz=timezone.utc)

    @property
    def time_ago(self) -> str:
        """Human-friendly relative time like '3 hours ago', '2 days ago'."""
        dt = self.timestamp_dt
        if dt is None:
            return ""
        delta = datetime.now(tz=timezone.utc) - dt
        seconds = int(delta.total_seconds())
        if seconds < 60:
            return "just now"
        minutes = seconds // 60
        if minutes < 60:
            return f"{minutes}m ago"
        hours = minutes // 60
        if hours < 24:
            return f"{hours}h ago"
        days = hours // 24
        if days < 30:
            return f"{days}d ago"
        months = days // 30
        if months < 12:
            return f"{months}mo ago"
        years = days // 365
        return f"{years}y ago"

    # -- Session reference --

    @property
    def session_ref(self) -> RecordRef | None:
        """Pointer to the session this entry belongs to."""
        return self._deserialize_ref(object.__getattribute__(self, "__dict__").get("session_ref"))

    @session_ref.setter
    def session_ref(self, value: RecordRef | None) -> None:
        object.__getattribute__(self, "__dict__")["session_ref"] = self._serialize_ref(value)
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("session_ref")

    @property
    def session(self) -> ClaudeSessionRecord | None:
        """Lazy-load the full session record.

        Uses the ``project`` field from the history entry for O(1)
        file lookup instead of scanning all project directories.
        """
        from .claude_session import ClaudeSessionRecord

        ref = self.session_ref
        if ref is None or not ref.id:
            return None
        project = getattr(self, "project", "") or ""
        return ClaudeSessionRecord.get(ref.id, project=project)

    # -- Factory --

    @classmethod
    def from_dict_entry(cls, raw: dict) -> Self:
        """Create from a parsed history.jsonl line."""
        rec = cls(
            display=raw.get("display", ""),
            timestamp_ms=raw.get("timestamp", 0),
            project=raw.get("project", ""),
            session_id=raw.get("sessionId", ""),
            raw_json=raw,
        )
        sid = raw.get("sessionId", "")
        if sid:
            rec.session_ref = RecordRef(id=sid, type=RecordType.CLAUDE_SESSION)
        return rec

    # -- Discovery --

    @classmethod
    def discover(cls, scope=None, **kwargs) -> list[ClaudeHistoryEntryFsRecord]:
        """Return all history entries from the default history file."""
        from .claude_history import ClaudeHistoryFsRecord

        return ClaudeHistoryFsRecord.default().entries

    @classmethod
    def get(cls, uid: str, scope=None, **kwargs) -> ClaudeHistoryEntryFsRecord | None:
        """Find a single history entry by uid (linear scan)."""
        for entry in cls.discover(scope=scope, **kwargs):
            if entry.id == uid:
                return entry
        return None
