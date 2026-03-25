"""ClaudeSettingsJsonFsRecord -- root record from settings.json.

Captures all top-level scalar and dict settings from Claude Code's
settings.json files (user, project, and local variants).
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from flow_sdk.fs_store import Record, RecordType

if TYPE_CHECKING:
    from flow_sdk.fs_store.scope import Scope


class ClaudeSettingsJsonFsRecord(Record):
    """Root record representing a settings.json file.

    Sources:
    - ``~/.claude/settings.json`` (user-level)
    - ``.claude/settings.json`` (project-level)
    - ``.claude/settings.local.json`` (local, git-ignored)
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS_JSON

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS_JSON
        super().__init__(**kwargs)

    @classmethod
    def from_raw(cls, data: dict, source_file: str | Path) -> ClaudeSettingsJsonFsRecord:
        """Create the root record from a parsed settings.json."""
        rec = cls(
            # Model configuration
            model=data.get("model", ""),
            available_models=data.get("availableModels", []),
            always_thinking_enabled=data.get("alwaysThinkingEnabled", False),
            # Auth & API
            api_key_helper=data.get("apiKeyHelper", ""),
            force_login_method=data.get("forceLoginMethod", ""),
            force_login_org_uuid=data.get("forceLoginOrgUUID", ""),
            # MCP control
            enable_all_project_mcp_servers=data.get("enableAllProjectMcpServers", False),
            enabled_mcpjson_servers=data.get("enabledMcpjsonServers", []),
            disabled_mcpjson_servers=data.get("disabledMcpjsonServers", []),
            # Hooks
            hooks=data.get("hooks", {}),
            disable_all_hooks=data.get("disableAllHooks", False),
            # Output & Display
            output_style=data.get("outputStyle", ""),
            language=data.get("language", ""),
            show_turn_duration=data.get("showTurnDuration", False),
            spinner_verbs=data.get("spinnerVerbs", {}),
            spinner_tips_enabled=data.get("spinnerTipsEnabled", False),
            spinner_tips_override=data.get("spinnerTipsOverride", {}),
            terminal_progress_bar_enabled=data.get("terminalProgressBarEnabled", False),
            prefers_reduced_motion=data.get("prefersReducedMotion", False),
            # Files & directories
            file_suggestion=data.get("fileSuggestion", {}),
            respect_gitignore=data.get("respectGitignore", True),
            plans_directory=data.get("plansDirectory", ""),
            # Environment & updates
            env=data.get("env", {}),
            auto_updates_channel=data.get("autoUpdatesChannel", ""),
            # Session & lifecycle
            cleanup_period_days=data.get("cleanupPeriodDays", 0),
            status_line=data.get("statusLine", {}),
            # Plugins & marketplaces
            enabled_plugins=data.get("enabledPlugins", {}),
            extra_known_marketplaces=data.get("extraKnownMarketplaces", {}),
            # Cloud providers
            aws_auth_refresh=data.get("awsAuthRefresh", ""),
            aws_credential_export=data.get("awsCredentialExport", ""),
            # Monitoring
            otel_headers_helper=data.get("otelHeadersHelper", ""),
            # Teams
            teammate_mode=data.get("teammateMode", ""),
            # Company
            company_announcements=data.get("companyAnnouncements", []),
            # Deprecated
            include_co_authored_by=data.get("includeCoAuthoredBy", True),
        )
        import uuid as _uuid
        rec.id = str(_uuid.uuid5(_uuid.NAMESPACE_DNS, "claude_settings_json:default"))
        rec.source_file = str(source_file)
        return rec

    @classmethod
    def discover(cls, scope: Scope | None = None, **kwargs) -> list[ClaudeSettingsJsonFsRecord]:
        """Extract settings records from the user-default settings.json."""
        from . import ClaudeSettingsJsonRecordList
        rl = ClaudeSettingsJsonRecordList.user_default()
        return [r for r in rl if isinstance(r, cls)]

    @classmethod
    def discover_one(cls, record_id: str, scope: Scope | None = None, **kwargs) -> ClaudeSettingsJsonFsRecord | None:
        """Find a specific settings record by id."""
        for r in cls.discover(scope=scope):
            if r.id == record_id:
                return r
        return None
