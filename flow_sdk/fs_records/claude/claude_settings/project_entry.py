"""ClaudeProjectEntryFsRecord -- a single project entry from ~/.claude.json /projects."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeProjectEntryFsRecord(Record):
    """A project entry from the ``projects`` dict in ~/.claude.json.

    The project path (filesystem path) serves as the unique id.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS_PROJECT

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS_PROJECT
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))
        if self.project_path and not object.__getattribute__(self, "__dict__").get("id"):
            object.__getattribute__(self, "__dict__")["id"] = self.project_path

    @property
    def project_path(self) -> str:
        return object.__getattribute__(self, "__dict__").get("project_path") or ""

    @property
    def has_sessions(self) -> bool:
        """Whether this project has had at least one session."""
        return bool(self.last_session_id)

    @property
    def total_tokens(self) -> int:
        """Total tokens (input + output) from the last session."""
        return self.last_total_input_tokens + self.last_total_output_tokens

    @classmethod
    def from_raw(cls, project_path: str, data: dict) -> ClaudeProjectEntryFsRecord:
        """Create from a project sub-object."""
        rec = cls(
            project_path=project_path,
            # Tool configuration
            allowed_tools=data.get("allowedTools", []),
            mcp_context_uris=data.get("mcpContextUris", []),
            enabled_mcpjson_servers=data.get("enabledMcpjsonServers", []),
            disabled_mcpjson_servers=data.get("disabledMcpjsonServers", []),
            disabled_mcp_servers=data.get("disabledMcpServers", []),
            ignore_patterns=data.get("ignorePatterns", []),
            # Onboarding
            has_trust_dialog_accepted=data.get("hasTrustDialogAccepted", False),
            project_onboarding_seen_count=data.get("projectOnboardingSeenCount", 0),
            has_completed_project_onboarding=data.get("hasCompletedProjectOnboarding", False),
            has_claude_md_external_includes_approved=data.get("hasClaudeMdExternalIncludesApproved", False),
            has_claude_md_external_includes_warning_shown=data.get("hasClaudeMdExternalIncludesWarningShown", False),
            # Example files
            example_files=data.get("exampleFiles", []),
            example_files_generated_at=data.get("exampleFilesGeneratedAt", 0),
            # Caches
            react_vulnerability_cache=data.get("reactVulnerabilityCache", {}),
            # Last session metrics
            last_cost=data.get("lastCost", 0.0),
            last_api_duration=data.get("lastAPIDuration", 0),
            last_api_duration_without_retries=data.get("lastAPIDurationWithoutRetries", 0),
            last_tool_duration=data.get("lastToolDuration", 0),
            last_duration=data.get("lastDuration", 0),
            last_lines_added=data.get("lastLinesAdded", 0),
            last_lines_removed=data.get("lastLinesRemoved", 0),
            last_total_input_tokens=data.get("lastTotalInputTokens", 0),
            last_total_output_tokens=data.get("lastTotalOutputTokens", 0),
            last_total_cache_creation_input_tokens=data.get("lastTotalCacheCreationInputTokens", 0),
            last_total_cache_read_input_tokens=data.get("lastTotalCacheReadInputTokens", 0),
            last_total_web_search_requests=data.get("lastTotalWebSearchRequests", 0),
            last_session_id=data.get("lastSessionId", ""),
            last_fps_average=data.get("lastFpsAverage", 0.0),
            last_fps_low_1pct=data.get("lastFpsLow1Pct", 0.0),
            last_session_metrics=data.get("lastSessionMetrics", {}),
        )
        rec.id = project_path
        rec.name = project_path.rsplit("/", 1)[-1] if "/" in project_path else project_path
        return rec
