"""ClaudeMcpJsonRecordList — extracts MCP server records from .mcp.json.

Parses both user-level (~/.claude/mcp.json) and project-level (.mcp.json,
.claude/mcp.json) MCP configuration files into ClaudeMcpServerFsRecord
instances.

Usage::

    mcp = ClaudeMcpJsonRecordList.user_default()
    for server in mcp:
        print(server.server_name, server.command or server.url)
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.json_file_record_store import JsonFileRecordStore, _escape_json_pointer
from flow_sdk.instance_settings import get_instance_settings

from .claude_mcp_server import ClaudeMcpServerFsRecord


__all__ = [
    "ClaudeMcpJsonRecordList",
]


@dataclass
class ClaudeMcpJsonRecordList(JsonFileRecordStore):
    """Extracts ClaudeMcpServerFsRecord instances from an mcp.json file.

    The file format is::

        {
          "mcpServers": {
            "server-name": {
              "type": "stdio",
              "command": "...",
              "args": [...],
              "env": {...}
            },
            "remote-server": {
              "type": "sse",
              "url": "https://..."
            }
          }
        }
    """

    scope: str = "user"

    def _extract(self, data: dict) -> list[Record]:
        records: list[Record] = []
        sf = str(self.source_file)

        servers = data.get("mcpServers", {})
        if not isinstance(servers, dict):
            return records

        for srv_name, srv_data in servers.items():
            if not isinstance(srv_data, dict):
                continue
            srv = ClaudeMcpServerFsRecord(
                server_name=srv_name,
                server_type=srv_data.get("type", ""),
                command=srv_data.get("command", ""),
                args=srv_data.get("args", []),
                env=srv_data.get("env", {}),
                url=srv_data.get("url", ""),
                scope=self.scope,
            )
            srv.json_path = f"/mcpServers/{_escape_json_pointer(srv_name)}"
            srv.source_file = sf
            records.append(srv)

        return records

    @property
    def servers(self) -> list[ClaudeMcpServerFsRecord]:
        """All MCP server records."""
        return [r for r in self if isinstance(r, ClaudeMcpServerFsRecord)]

    def get_server(self, name: str) -> ClaudeMcpServerFsRecord | None:
        """Find a server by name."""
        for r in self:
            if isinstance(r, ClaudeMcpServerFsRecord) and r.server_name == name:
                return r
        return None

    @classmethod
    def user_default(cls) -> ClaudeMcpJsonRecordList:
        """Create a record list backed by ~/.claude/mcp.json."""
        return cls(source_file=get_instance_settings().claude_mcp_json_path, scope="user")

    @classmethod
    def for_project(cls, project_dir: str | Path) -> ClaudeMcpJsonRecordList:
        """Create a record list for a project's .mcp.json."""
        return cls(source_file=Path(project_dir) / ".mcp.json", scope="project")

    @classmethod
    def for_project_claude_dir(cls, project_dir: str | Path) -> ClaudeMcpJsonRecordList:
        """Create a record list for a project's .claude/mcp.json."""
        return cls(source_file=Path(project_dir) / ".claude" / "mcp.json", scope="project")


def _register_file_patterns() -> None:
    """Register mcp.json filename patterns for the path-based source file API."""
    from flow_sdk.fs_store.source_file_registry import register_file_pattern

    register_file_pattern("mcp.json", ClaudeMcpJsonRecordList)
    register_file_pattern(".mcp.json", ClaudeMcpJsonRecordList)


# Auto-register on import
_register_file_patterns()
