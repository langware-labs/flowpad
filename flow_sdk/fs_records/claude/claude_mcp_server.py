"""ClaudeMcpServerFsRecord — represents a configured MCP server.

Source: ~/.claude/mcp.json (user-level), .mcp.json or .claude/mcp.json (project-level)
Each server has a command, args, optional env vars, a scope, and optionally
a url (for SSE/HTTP transport) and server_type (stdio, sse, http).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from flow_sdk.fs_store import Record, RecordType

if TYPE_CHECKING:
    from flow_sdk.fs_store.scope import Scope as ScopeType


class ClaudeMcpServerFsRecord(Record):
    """An MCP server configuration.

    Mapped from ``mcp.json`` ``mcpServers.<name>`` entries.
    """

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.MCP_SERVER
        kwargs.setdefault("server_name", "")
        kwargs.setdefault("server_type", "")
        kwargs.setdefault("command", "")
        kwargs.setdefault("args", [])
        kwargs.setdefault("env", {})
        kwargs.setdefault("url", "")
        kwargs.setdefault("scope", "user")
        super().__init__(**kwargs)
        if self.server_name:
            scope_val = self.scope.value if hasattr(self.scope, "value") else self.scope
            self.id = f"{scope_val}:{self.server_name}"
            if not self.name:
                self.name = self.server_name
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @classmethod
    def discover(cls, scope: ScopeType | None = None, **kwargs) -> list[ClaudeMcpServerFsRecord]:
        """Extract MCP server records from the user-default mcp.json."""
        from .claude_mcp_json import ClaudeMcpJsonRecordList
        rl = ClaudeMcpJsonRecordList.user_default()
        return [r for r in rl if isinstance(r, cls)]

    @classmethod
    def get(cls, uid: str, scope: ScopeType | None = None, **kwargs) -> ClaudeMcpServerFsRecord | None:
        """Find a specific MCP server record by uid."""
        for r in cls.discover(scope=scope):
            if r.id == uid:
                return r
        return None
