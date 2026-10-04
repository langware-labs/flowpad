"""A project's git, shared with its members through the hub.

A project whose code lives in a private GitHub repo can let its members clone
and push it through the hub with their FlowPad login — no GitHub access of their
own. The hub links the repo under the project and relays git to GitHub with a
token the Flowpad GitHub App mints per request, scoped to that one repo; the
member's project role decides read (pull) or write (push).

``GitShare`` is the answer to "is this project's git shared, and if not, what is
missing" — the same value from the SDK (``Project.git_share``), the desk action
and the TS SDK.
"""

from __future__ import annotations

from typing import Any, ClassVar, Optional

from pydantic import ConfigDict

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec


class GitShareStatus(StrEnum):
    """Where a project's git share stands."""

    #: Members clone and push through the hub at ``clone_url``.
    SHARED = "shared"
    #: Not shared (never was, or was unshared).
    NOT_SHARED = "not_shared"
    #: The Flowpad GitHub App is not installed on the repo: install it at ``install_url``, then ask again.
    INSTALL_REQUIRED = "install_required"
    #: The hub has no GitHub connection for the caller, so it cannot check they may share the repo.
    GITHUB_CONNECT_REQUIRED = "github_connect_required"
    #: The repo is public: anyone can already clone it, there is nothing to share.
    NOT_PRIVATE = "not_private"


class GitShareError(RuntimeError):
    """A project's git cannot be shared from here (no cloud link, no GitHub origin)."""


class GitShare(DataSpec):
    """A project's git share, as the hub reports it."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "project.git_share"

    status: GitShareStatus = GitShareStatus.NOT_SHARED
    #: The GitHub repo, ``owner/name``.
    repo: str = ""
    #: The hub's ``git_repo`` typeid serving it (set when shared).
    git_repo: Optional[str] = None
    #: What a member clones, with their hub login (set when shared).
    clone_url: Optional[str] = None
    #: The GitHub App install page for ``repo`` (set when the App must be installed first).
    install_url: Optional[str] = None
    #: The branch members get by default.
    default_branch: str = "main"

    @property
    def shared(self) -> bool:
        return self.status is GitShareStatus.SHARED

    @classmethod
    def from_hub(cls, data: Any) -> "GitShare":
        """Project the hub's answer field by field — a key this side does not model is dropped."""
        if not isinstance(data, dict):
            return cls()
        return cls(
            status=GitShareStatus(data.get("status") or GitShareStatus.NOT_SHARED),
            repo=str(data.get("repo") or ""),
            git_repo=data.get("git_repo") or None,
            clone_url=data.get("clone_url") or None,
            install_url=data.get("install_url") or None,
            default_branch=str(data.get("default_branch") or "main"),
        )
