"""Application service for publishing one file-backed asset through Git."""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator

from flow_sdk._compat import StrEnum
from flow_sdk.assets.git_origin import PortableGitOrigin


class AssetPublishCode(StrEnum):
    NOT_GIT_BACKED = "not_git_backed"
    PROJECT_NOT_PUBLISHED = "project_not_published"
    GITHUB_NOT_CONNECTED = "github_not_connected"
    ORIGIN_INVALID = "origin_invalid"
    BRANCH_AHEAD = "branch_ahead"
    BRANCH_DIVERGED = "branch_diverged"
    PUSH_REJECTED = "push_rejected"
    HUB_PUBLISH_FAILED = "hub_publish_failed"


class AssetPublishError(RuntimeError):
    """Typed, intentionally secret-free asset publication failure."""

    def __init__(self, code: AssetPublishCode, message: str, *, data: dict | None = None):
        super().__init__(message)
        self.code = code
        self.data = data or {}


class GitAuthor(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str
    email: str
    typeid: str | None = None

    @field_validator("name", "email", "typeid")
    @classmethod
    def _safe_commit_identity(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value or any(ord(ch) < 32 for ch in value) or any(ch in value for ch in "<>\n\r"):
            raise ValueError("Git author identity contains forbidden characters")
        return value


class AssetGitReceipt(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    changed: bool
    repo_root: Path = Field(exclude=True)
    branch: str
    head_commit: str
    origin: PortableGitOrigin


class AssetPublishResult(BaseModel):
    project: dict
    asset: dict
    git: dict
    local_cache_warning: str | None = None


async def publish_git_asset(entity, actor) -> AssetPublishResult:
    """Publish an asset's path-only Git commit and register it under its Project."""
    from flow_sdk.assets._publish_service import publish_git_asset_impl  # noqa: PLC0415

    return await publish_git_asset_impl(entity, actor)


__all__ = [
    "AssetGitReceipt",
    "AssetPublishCode",
    "AssetPublishError",
    "AssetPublishResult",
    "GitAuthor",
    "publish_git_asset",
]
