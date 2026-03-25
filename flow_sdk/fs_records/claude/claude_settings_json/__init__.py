"""ClaudeSettingsJsonRecordList — extracts typed records from settings.json.

Usage::

    settings = ClaudeSettingsJsonRecordList.user_default()
    for record in settings:
        print(record.type, record.json_path)

    root = settings.root
    perms = settings.permissions
    sandbox = settings.sandbox

    # Write-back: update env vars and persist to settings.json
    settings.update("claude_settings_json", "default", {"env": {"MY_VAR": "hello"}})
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from flow_sdk.fs_store import Record, RecordRef, RecordType
from flow_sdk.fs_store.json_file_record_store import JsonFileRecordStore

from .base import ClaudeSettingsJsonFsRecord
from .permissions import ClaudePermissionsFsRecord
from .sandbox import ClaudeSandboxFsRecord
from .attribution import ClaudeAttributionFsRecord

__all__ = [
    "ClaudeSettingsJsonRecordList",
    "ClaudeSettingsJsonFsRecord",
    "ClaudePermissionsFsRecord",
    "ClaudeSandboxFsRecord",
    "ClaudeAttributionFsRecord",
]

# Record types that belong to this source-file list
SETTINGS_JSON_RECORD_TYPES = [
    RecordType.CLAUDE_SETTINGS_JSON,
    RecordType.CLAUDE_SETTINGS_JSON_PERMISSIONS,
    RecordType.CLAUDE_SETTINGS_JSON_SANDBOX,
    RecordType.CLAUDE_SETTINGS_JSON_ATTRIBUTION,
]


@dataclass
class ClaudeSettingsJsonRecordList(JsonFileRecordStore):
    """Extracts all settings records from a settings.json file."""

    def _extract(self, data: dict) -> list[Record]:
        records: list[Record] = []
        sf = str(self.source_file)

        # Root record (all top-level scalars and dicts)
        root = ClaudeSettingsJsonFsRecord.from_raw(data, self.source_file)
        root.json_path = ""
        records.append(root)

        root_ref = RecordRef.from_record(root)

        # Permissions block
        if "permissions" in data and isinstance(data["permissions"], dict):
            perms = ClaudePermissionsFsRecord.from_raw(data["permissions"])
            perms.json_path = "/permissions"
            perms.source_file = sf
            perms.parent_ref = root_ref
            records.append(perms)

        # Sandbox block
        if "sandbox" in data and isinstance(data["sandbox"], dict):
            sandbox = ClaudeSandboxFsRecord.from_raw(data["sandbox"])
            sandbox.json_path = "/sandbox"
            sandbox.source_file = sf
            sandbox.parent_ref = root_ref
            records.append(sandbox)

        # Attribution block
        if "attribution" in data and isinstance(data["attribution"], dict):
            attr = ClaudeAttributionFsRecord.from_raw(data["attribution"])
            attr.json_path = "/attribution"
            attr.source_file = sf
            attr.parent_ref = root_ref
            records.append(attr)

        return records

    def _record_to_json(self, record: Record) -> dict[str, Any]:
        """Convert a settings record back to its camelCase JSON fragment.

        Handles the special case of ClaudeSandboxFsRecord which has a nested
        ``network`` sub-block that must be reconstructed from flat fields.
        """
        if isinstance(record, ClaudeSandboxFsRecord):
            return {
                "enabled": record.enabled,
                "autoAllowBashIfSandboxed": record.auto_allow_bash_if_sandboxed,
                "excludedCommands": record.excluded_commands,
                "allowUnsandboxedCommands": record.allow_unsandboxed_commands,
                "enableWeakerNestedSandbox": record.enable_weaker_nested_sandbox,
                "network": {
                    "allowedDomains": record.network_allowed_domains,
                    "allowUnixSockets": record.network_allow_unix_sockets,
                    "allowAllUnixSockets": record.network_allow_all_unix_sockets,
                    "allowLocalBinding": record.network_allow_local_binding,
                    "httpProxyPort": record.network_http_proxy_port,
                    "socksProxyPort": record.network_socks_proxy_port,
                },
            }
        # Default: use the generic snake_case → camelCase converter
        from flow_sdk.fs_store.source_file_record_list import _default_record_to_json
        return _default_record_to_json(record)

    # -- Convenience accessors --

    @property
    def root(self) -> ClaudeSettingsJsonFsRecord:
        """The root settings record."""
        for r in self:
            if isinstance(r, ClaudeSettingsJsonFsRecord):
                return r
        raise ValueError("No root record found")

    @property
    def permissions(self) -> ClaudePermissionsFsRecord | None:
        """The permissions record, or None if absent."""
        for r in self:
            if isinstance(r, ClaudePermissionsFsRecord):
                return r
        return None

    @property
    def sandbox(self) -> ClaudeSandboxFsRecord | None:
        """The sandbox record, or None if absent."""
        for r in self:
            if isinstance(r, ClaudeSandboxFsRecord):
                return r
        return None

    @property
    def attribution(self) -> ClaudeAttributionFsRecord | None:
        """The attribution record, or None if absent."""
        for r in self:
            if isinstance(r, ClaudeAttributionFsRecord):
                return r
        return None

    @classmethod
    def user_default(cls) -> ClaudeSettingsJsonRecordList:
        """Create a record list backed by the default ~/.claude/settings.json."""
        return cls(source_file=Path.home() / ".claude" / "settings.json")

    @classmethod
    def for_project(cls, project_dir: str | Path) -> ClaudeSettingsJsonRecordList:
        """Create a record list for a project's .claude/settings.json."""
        return cls(source_file=Path(project_dir) / ".claude" / "settings.json")

    @classmethod
    def for_local(cls, project_dir: str | Path) -> ClaudeSettingsJsonRecordList:
        """Create a record list for a project's .claude/settings.local.json."""
        return cls(source_file=Path(project_dir) / ".claude" / "settings.local.json")


def _register_file_patterns() -> None:
    """Register filename patterns for the path-based source file API."""
    from flow_sdk.fs_store.source_file_registry import register_file_pattern

    register_file_pattern("settings.json", ClaudeSettingsJsonRecordList)
    register_file_pattern("settings.local.json", ClaudeSettingsJsonRecordList)


# Auto-register on import
_register_file_patterns()
