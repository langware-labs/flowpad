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


#: What each failure means over HTTP, and what the person should DO about it.
#:
#: One table, beside the codes it describes, because both the share action and
#: the agent deploy action answer the same question and a second copy drifts.
#: The remedy matters as much as the status: "Asset has no owning Project" names
#: the problem and leaves the reader stuck, which is exactly how a deploy button
#: ends up looking broken.
_PUBLISH_FAILURE: dict[str, tuple[int, str]] = {
    AssetPublishCode.NOT_GIT_BACKED: (
        400,
        "Create it inside a project — publishing goes through that project's repository.",
    ),
    AssetPublishCode.PROJECT_NOT_PUBLISHED: (
        409,
        "Publish its project first — the asset travels inside that repository.",
    ),
    AssetPublishCode.GITHUB_NOT_CONNECTED: (
        409,
        "Publishing pushes the asset to its project's repository, so the connection must exist first.",
    ),
    AssetPublishCode.ORIGIN_INVALID: (409, "Check the project's git remote."),
    AssetPublishCode.BRANCH_AHEAD: (409, "Push the project's branch first."),
    AssetPublishCode.BRANCH_DIVERGED: (409, "Reconcile the project's branch with its remote first."),
    AssetPublishCode.PUSH_REJECTED: (502, "The remote refused the push — check access to the repository."),
    AssetPublishCode.HUB_PUBLISH_FAILED: (502, "The hub could not accept it; try again shortly."),
}


def publish_failure_status(code: AssetPublishCode) -> int:
    """The HTTP status for a publish failure. Unknown codes are a server fault."""
    return _PUBLISH_FAILURE.get(code, (500, ""))[0]


def publish_failure_remedy(code: AssetPublishCode) -> str:
    """One sentence telling the reader what to do. Empty when there is nothing useful."""
    return _PUBLISH_FAILURE.get(code, (500, ""))[1]


class AssetPublishError(RuntimeError):
    """Typed, intentionally secret-free asset publication failure."""

    def __init__(self, code: AssetPublishCode, message: str, *, data: dict | None = None):
        super().__init__(message)
        self.code = code
        self.data = data or {}

    @property
    def actionable(self) -> str:
        """The failure and its remedy in one sentence a person can act on."""
        remedy = publish_failure_remedy(self.code)
        return f"{self} — {remedy}" if remedy else str(self)


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
