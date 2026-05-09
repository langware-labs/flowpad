"""ClaudeManagedSettingsFsRecord — managed-settings.json deployed by IT.

System-level managed configuration that restricts user settings.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.json_file_record_store import JsonFileRecordStore
from flow_sdk.instance_settings import get_instance_settings

if TYPE_CHECKING:
    from flow_sdk.fs_store.scope import Scope


class ClaudeManagedSettingsFsRecord(Record):
    """Managed settings record from managed-settings.json.

    These are system-level restrictions deployed by IT administrators.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_MANAGED_SETTINGS

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_MANAGED_SETTINGS
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @classmethod
    def from_raw(cls, data: dict, source_file: str | Path) -> ClaudeManagedSettingsFsRecord:
        """Create from a parsed managed-settings.json."""
        # sandbox.network.allowManagedDomainsOnly lives nested
        sandbox = data.get("sandbox", {})
        network = sandbox.get("network", {}) if isinstance(sandbox, dict) else {}

        rec = cls(
            allowed_mcp_servers=data.get("allowedMcpServers", []),
            denied_mcp_servers=data.get("deniedMcpServers", []),
            allow_managed_mcp_servers_only=data.get("allowManagedMcpServersOnly", False),
            allow_managed_hooks_only=data.get("allowManagedHooksOnly", False),
            allow_managed_permission_rules_only=data.get("allowManagedPermissionRulesOnly", False),
            strict_known_marketplaces=data.get("strictKnownMarketplaces", []),
            blocked_marketplaces=data.get("blockedMarketplaces", []),
            sandbox_network_allow_managed_domains_only=network.get("allowManagedDomainsOnly", False),
        )
        rec.id = "default"
        rec.source_file = str(source_file)
        return rec

    @classmethod
    def discover(cls, scope: Scope | None = None, **kwargs) -> list[ClaudeManagedSettingsFsRecord]:
        """Extract managed settings from the system-level managed-settings.json."""
        rl = ClaudeManagedSettingsRecordList(
            source_file=get_instance_settings().claude_managed_settings_path
        )
        return [r for r in rl if isinstance(r, cls)]

    @classmethod
    def get(cls, uid: str, scope: Scope | None = None, **kwargs) -> ClaudeManagedSettingsFsRecord | None:
        """Find a specific managed settings record by uid."""
        for r in cls.discover(scope=scope):
            if r.id == uid:
                return r
        return None


@dataclass
class ClaudeManagedSettingsRecordList(JsonFileRecordStore):
    """Extracts records from managed-settings.json."""

    def _extract(self, data: dict) -> list[Record]:
        root = ClaudeManagedSettingsFsRecord.from_raw(data, self.source_file)
        root.json_path = ""
        return [root]

    @property
    def root(self) -> ClaudeManagedSettingsFsRecord:
        """The managed settings root record."""
        for r in self:
            if isinstance(r, ClaudeManagedSettingsFsRecord):
                return r
        raise ValueError("No root record found")


def _register_file_patterns() -> None:
    """Register managed-settings.json filename pattern for the path-based source file API."""
    from flow_sdk.fs_store.source_file_registry import register_file_pattern

    register_file_pattern("managed-settings.json", ClaudeManagedSettingsRecordList)


# Auto-register on import
_register_file_patterns()
