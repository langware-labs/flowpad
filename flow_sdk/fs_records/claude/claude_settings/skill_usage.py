"""ClaudeSkillUsageFsRecord -- per-skill usage entry from ~/.claude.json."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeSkillUsageFsRecord(Record):
    """Usage statistics for a single skill."""

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS_SKILL_USAGE

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS_SKILL_USAGE
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))
        if self.skill_name and not object.__getattribute__(self, "__dict__").get("id"):
            object.__getattribute__(self, "__dict__")["id"] = self.skill_name

    @property
    def skill_name(self) -> str:
        return object.__getattribute__(self, "__dict__").get("skill_name") or ""

    @classmethod
    def from_raw(cls, skill_name: str, data: dict) -> ClaudeSkillUsageFsRecord:
        """Create from a skillUsage entry."""
        rec = cls(
            skill_name=skill_name,
            usage_count=data.get("usageCount", 0),
            last_used_at=data.get("lastUsedAt", 0),
        )
        rec.id = skill_name
        rec.name = skill_name
        return rec
