"""ClaudeSettingsMcpServerFsRecord -- MCP server config within a project."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeSettingsMcpServerFsRecord(Record):
    """An MCP server configuration within a project entry."""

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS_MCP_SERVER

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS_MCP_SERVER
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @classmethod
    def from_raw(cls, server_name: str, data: dict) -> ClaudeSettingsMcpServerFsRecord:
        """Create from an mcpServers entry."""
        rec = cls(
            server_name=server_name,
            server_type=data.get("type", ""),
            command=data.get("command", ""),
            args=data.get("args", []),
            env=data.get("env", {}),
            url=data.get("url", ""),
        )
        rec.id = server_name
        rec.name = server_name
        return rec
