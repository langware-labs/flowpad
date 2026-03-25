"""ClaudeSettingsRecordList — extracts typed records from ~/.claude.json.

Usage::

    settings = ClaudeSettingsRecordList.default()
    for record in settings:
        print(record.type, record.json_path)

    root = settings.root
    oauth = settings.oauth_account
    projects = settings.by_type(RecordType.CLAUDE_SETTINGS_PROJECT)
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from flow_sdk.fs_store import Record, RecordRef, RecordType
from flow_sdk.fs_store.json_file_record_store import JsonFileRecordStore, _escape_json_pointer

from .base import ClaudeSettingsFsRecord
from .oauth_account import ClaudeOAuthAccountFsRecord
from .project_entry import ClaudeProjectEntryFsRecord
from .model_usage import ClaudeModelUsageFsRecord
from .mcp_server_config import ClaudeSettingsMcpServerFsRecord
from .feature_flags import ClaudeFeatureFlagsFsRecord
from .tips_history import ClaudeTipsHistoryFsRecord
from .skill_usage import ClaudeSkillUsageFsRecord
from .github_repos import ClaudeGithubReposFsRecord

__all__ = [
    "ClaudeSettingsRecordList",
    "ClaudeSettingsFsRecord",
    "ClaudeOAuthAccountFsRecord",
    "ClaudeProjectEntryFsRecord",
    "ClaudeModelUsageFsRecord",
    "ClaudeSettingsMcpServerFsRecord",
    "ClaudeFeatureFlagsFsRecord",
    "ClaudeTipsHistoryFsRecord",
    "ClaudeSkillUsageFsRecord",
    "ClaudeGithubReposFsRecord",
]


@dataclass
class ClaudeSettingsRecordList(JsonFileRecordStore):
    """Extracts all settings records from ~/.claude.json."""

    def _extract(self, data: dict) -> list[Record]:
        records: list[Record] = []
        sf = str(self.source_file)

        # Root record
        root = ClaudeSettingsFsRecord._from_raw(data, self.source_file)
        root.json_path = ""
        records.append(root)

        root_ref = RecordRef.from_record(root)

        # OAuth account
        if "oauthAccount" in data:
            oauth = ClaudeOAuthAccountFsRecord.from_raw(data["oauthAccount"])
            oauth.json_path = "/oauthAccount"
            oauth.source_file = sf
            oauth.parent_ref = root_ref
            records.append(oauth)

        # Feature flags (always present, even if empty)
        flags = ClaudeFeatureFlagsFsRecord.from_raw(data)
        flags.json_path = "/cachedStatsigGates"
        flags.source_file = sf
        flags.parent_ref = root_ref
        records.append(flags)

        # Tips history
        if "tipsHistory" in data:
            tips = ClaudeTipsHistoryFsRecord.from_raw(data["tipsHistory"])
            tips.json_path = "/tipsHistory"
            tips.source_file = sf
            tips.parent_ref = root_ref
            records.append(tips)

        # GitHub repos
        if "githubRepoPaths" in data:
            repos = ClaudeGithubReposFsRecord.from_raw(data["githubRepoPaths"])
            repos.json_path = "/githubRepoPaths"
            repos.source_file = sf
            repos.parent_ref = root_ref
            records.append(repos)

        # Skill usage entries (one record per skill)
        for skill_name, usage in data.get("skillUsage", {}).items():
            su = ClaudeSkillUsageFsRecord.from_raw(skill_name, usage)
            su.json_path = f"/skillUsage/{_escape_json_pointer(skill_name)}"
            su.source_file = sf
            su.parent_ref = root_ref
            records.append(su)

        # Projects (one record per project + nested model usage + MCP servers)
        for proj_path, proj_data in data.get("projects", {}).items():
            if not isinstance(proj_data, dict):
                continue
            proj = ClaudeProjectEntryFsRecord.from_raw(proj_path, proj_data)
            proj.json_path = f"/projects/{_escape_json_pointer(proj_path)}"
            proj.source_file = sf
            proj.parent_ref = root_ref
            records.append(proj)

            proj_ref = RecordRef.from_record(proj)

            # Model usage entries within project
            for model_id, usage in proj_data.get("lastModelUsage", {}).items():
                if not isinstance(usage, dict):
                    continue
                mu = ClaudeModelUsageFsRecord.from_raw(model_id, usage)
                mu.json_path = f"{proj.json_path}/lastModelUsage/{_escape_json_pointer(model_id)}"
                mu.source_file = sf
                mu.parent_ref = proj_ref
                records.append(mu)

            # MCP server configs within project
            for srv_name, srv_data in proj_data.get("mcpServers", {}).items():
                if not isinstance(srv_data, dict):
                    continue
                srv = ClaudeSettingsMcpServerFsRecord.from_raw(srv_name, srv_data)
                srv.json_path = f"{proj.json_path}/mcpServers/{_escape_json_pointer(srv_name)}"
                srv.source_file = sf
                srv.parent_ref = proj_ref
                records.append(srv)

        return records

    # -- Convenience accessors --

    @property
    def root(self) -> ClaudeSettingsFsRecord:
        """The root settings record."""
        for r in self:
            if isinstance(r, ClaudeSettingsFsRecord):
                return r
        raise ValueError("No root record found")

    @property
    def oauth_account(self) -> ClaudeOAuthAccountFsRecord | None:
        """The OAuth account record, or None if not logged in."""
        for r in self:
            if isinstance(r, ClaudeOAuthAccountFsRecord):
                return r
        return None

    @property
    def feature_flags(self) -> ClaudeFeatureFlagsFsRecord:
        """The feature flags record."""
        for r in self:
            if isinstance(r, ClaudeFeatureFlagsFsRecord):
                return r
        raise ValueError("No feature flags record found")

    @property
    def tips_history(self) -> ClaudeTipsHistoryFsRecord | None:
        """The tips history record, or None if absent."""
        for r in self:
            if isinstance(r, ClaudeTipsHistoryFsRecord):
                return r
        return None

    @property
    def github_repos(self) -> ClaudeGithubReposFsRecord | None:
        """The GitHub repos record, or None if absent."""
        for r in self:
            if isinstance(r, ClaudeGithubReposFsRecord):
                return r
        return None

    @property
    def projects(self) -> list[ClaudeProjectEntryFsRecord]:
        """All project entry records."""
        return [r for r in self if isinstance(r, ClaudeProjectEntryFsRecord)]

    @property
    def skill_usages(self) -> list[ClaudeSkillUsageFsRecord]:
        """All skill usage records."""
        return [r for r in self if isinstance(r, ClaudeSkillUsageFsRecord)]

    @classmethod
    def default(cls) -> ClaudeSettingsRecordList:
        """Create a record list backed by the default ~/.claude.json."""
        return cls(source_file=Path.home() / ".claude.json")


def _register_file_patterns() -> None:
    """Register .claude.json filename pattern for the path-based source file API."""
    from flow_sdk.fs_store.source_file_registry import register_file_pattern

    register_file_pattern(".claude.json", ClaudeSettingsRecordList)


# Auto-register on import
_register_file_patterns()
