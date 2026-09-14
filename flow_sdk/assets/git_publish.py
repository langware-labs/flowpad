"""Application service for publishing one file-backed asset through Git."""

from __future__ import annotations

from pathlib import Path

from pydantic import ConfigDict, Field, field_validator

from flow_sdk._compat import StrEnum
from flow_sdk.assets.git_origin import PortableGitOrigin
from flow_sdk.schema.data_spec import DataSpec


class AssetPublishCode(StrEnum):
    NOT_GIT_BACKED = "not_git_backed"
    PROJECT_NOT_PUBLISHED = "project_not_published"
    GITHUB_NOT_CONNECTED = "github_not_connected"
    ORIGIN_INVALID = "origin_invalid"
    BRANCH_AHEAD = "branch_ahead"
    BRANCH_DIVERGED = "branch_diverged"
    PUSH_REJECTED = "push_rejected"
    HUB_PUBLISH_FAILED = "hub_publish_failed"


class PublishFailure(DataSpec):
    """What a publish code means over HTTP, and what the person should DO."""

    status: int
    remedy: str


#: One table, beside the codes it describes, because the share action, the agent
#: deploy action and the CLI all answer the same question and a second copy
#: drifts. The remedy matters as much as the status: "Asset has no owning
#: Project" names the problem and leaves the reader stuck, which is how a deploy
#: button ends up looking broken.
_PUBLISH_FAILURE: dict[AssetPublishCode, PublishFailure] = {
    AssetPublishCode.NOT_GIT_BACKED: PublishFailure(
        status=400, remedy="Create it inside a project — publishing goes through that project's repository."
    ),
    AssetPublishCode.PROJECT_NOT_PUBLISHED: PublishFailure(
        status=409, remedy="Publish its project first — the asset travels inside that repository."
    ),
    AssetPublishCode.GITHUB_NOT_CONNECTED: PublishFailure(
        status=409, remedy="Publishing pushes the asset to its project's repository, so the connection must exist first."
    ),
    AssetPublishCode.ORIGIN_INVALID: PublishFailure(status=409, remedy="Check the project's git remote."),
    AssetPublishCode.BRANCH_AHEAD: PublishFailure(status=409, remedy="Push the project's branch first."),
    AssetPublishCode.BRANCH_DIVERGED: PublishFailure(
        status=409, remedy="Reconcile the project's branch with its remote first."
    ),
    AssetPublishCode.PUSH_REJECTED: PublishFailure(
        status=502, remedy="The remote refused the push — check access to the repository."
    ),
    AssetPublishCode.HUB_PUBLISH_FAILED: PublishFailure(
        status=502, remedy="The hub could not accept it; try again shortly."
    ),
}

#: A code with no row is a fault we did not anticipate, so it reads as one.
_UNKNOWN_FAILURE = PublishFailure(status=500, remedy="")


def publish_failure(code: AssetPublishCode) -> PublishFailure:
    """The status and remedy for a publish code."""
    return _PUBLISH_FAILURE.get(code, _UNKNOWN_FAILURE)


class AssetPublishError(RuntimeError):
    """Typed, intentionally secret-free asset publication failure."""

    def __init__(self, code: AssetPublishCode, message: str, *, data: dict | None = None):
        super().__init__(message)
        self.code = code
        self.data = data or {}

    @property
    def status_code(self) -> int:
        """The HTTP status this failure deserves.

        On the exception rather than looked up per call site, matching
        `ProjectPublishBlocked` — which `share_action` already handles that way,
        in the same function.
        """
        return publish_failure(self.code).status

    @property
    def remedy(self) -> str:
        """One sentence telling the reader what to do. Empty when there is none."""
        return publish_failure(self.code).remedy

    @property
    def actionable(self) -> str:
        """The failure and its remedy in one sentence a person can act on."""
        return f"{self} — {self.remedy}" if self.remedy else str(self)


class GitAuthor(DataSpec):
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


class AssetGitReceipt(DataSpec):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    changed: bool
    repo_root: Path = Field(exclude=True)
    branch: str
    head_commit: str
    origin: PortableGitOrigin


class AssetPublishResult(DataSpec):
    project: dict
    asset: dict
    git: dict
    local_cache_warning: str | None = None



__all__ = [
    "AssetGitReceipt",
    "AssetPublishCode",
    "AssetPublishError",
    "AssetPublishResult",
    "GitAuthor",
]
