"""ClaudeAttributionFsRecord — attribution block from settings.json."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeAttributionFsRecord(Record):
    """Attribution configuration from settings.json ``attribution`` block.

    Controls how Claude Code credits itself in commits and PRs.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS_JSON_ATTRIBUTION

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS_JSON_ATTRIBUTION
        super().__init__(**kwargs)

    @classmethod
    def from_raw(cls, data: dict) -> ClaudeAttributionFsRecord:
        """Create from an ``attribution`` block."""
        rec = cls(
            commit=data.get("commit", ""),
            pr=data.get("pr", ""),
        )
        import uuid as _uuid
        rec.id = str(_uuid.uuid5(_uuid.NAMESPACE_DNS, "claude_settings_json_attribution:default"))
        return rec
