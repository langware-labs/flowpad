"""ClaudePermissionsFsRecord — permissions block from settings.json."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudePermissionsFsRecord(Record):
    """Permissions configuration from settings.json ``permissions`` block.

    Controls which tools are allowed, denied, or require confirmation.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS_JSON_PERMISSIONS

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS_JSON_PERMISSIONS
        super().__init__(**kwargs)

    @classmethod
    def from_raw(cls, data: dict) -> ClaudePermissionsFsRecord:
        """Create from a ``permissions`` block."""
        rec = cls(
            allow=data.get("allow", []),
            ask=data.get("ask", []),
            deny=data.get("deny", []),
            additional_directories=data.get("additionalDirectories", []),
            default_mode=data.get("defaultMode", ""),
            disable_bypass_permissions_mode=data.get("disableBypassPermissionsMode", ""),
        )
        import uuid as _uuid
        rec.id = str(_uuid.uuid5(_uuid.NAMESPACE_DNS, "claude_settings_json_permissions:default"))
        return rec
