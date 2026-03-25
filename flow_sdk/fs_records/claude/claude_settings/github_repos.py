"""ClaudeGithubReposFsRecord -- GitHub repo path mappings from ~/.claude.json."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeGithubReposFsRecord(Record):
    """Maps GitHub repo slugs to local filesystem paths."""

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS_GITHUB_REPOS

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS_GITHUB_REPOS
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @property
    def repos(self) -> dict[str, list[str]]:
        return object.__getattribute__(self, "__dict__").get("repos") or {}

    @property
    def repo_count(self) -> int:
        """Number of distinct GitHub repos tracked."""
        return len(self.repos)

    def get_paths(self, repo: str) -> list[str]:
        """Return local paths for a given repo slug, or empty list."""
        return self.repos.get(repo, [])

    @classmethod
    def from_raw(cls, data: dict) -> ClaudeGithubReposFsRecord:
        """Create from the githubRepoPaths sub-object."""
        rec = cls(repos=dict(data))
        rec.id = "default"
        return rec
