"""ClaudeTipsHistoryFsRecord -- tips display history from ~/.claude.json."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeTipsHistoryFsRecord(Record):
    """Tracks how many times each tip has been shown."""

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS_TIPS_HISTORY

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS_TIPS_HISTORY
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @property
    def tips(self) -> dict[str, int]:
        return object.__getattribute__(self, "__dict__").get("tips") or {}

    @property
    def tip_count(self) -> int:
        """Total number of distinct tips tracked."""
        return len(self.tips)

    @property
    def most_shown_tip(self) -> str | None:
        """The tip name with the highest display count, or None if empty."""
        if not self.tips:
            return None
        return max(self.tips, key=self.tips.get)  # type: ignore[arg-type]

    @classmethod
    def from_raw(cls, data: dict) -> ClaudeTipsHistoryFsRecord:
        """Create from the tipsHistory sub-object."""
        rec = cls(tips=dict(data))
        rec.id = "default"
        return rec
