"""GitRepo entity — a shareable pointer to a "git location" (repo + branch).

Sender attaches one of these to a conversation message; recipient sees a
chip in their FlowMessage bubble and opens an accept-modal that drives the
local clone / checkout / pull against the recipient's chosen project.

Fields are non-secret metadata mirroring the canonical ``RepoSummary`` shape
produced by ``flow_sdk/app/actions/repo_actions.py:list_user_repos`` plus a
``branch`` and ``head_commit`` snapshot taken at share time. No tokens, no
SSH keys, no local paths.

Identity: ``id`` is a fresh ``uuid4`` per materialization (Entity default
factory). Two senders sharing the same upstream repo produce two distinct
``GitRepo`` TypeIds — no deterministic discovery possible from a public
URL.
"""
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class GitRepo(Entity):
    type: str = APIField(default="git_repo")

    # Provider + identity.
    provider: str = APIField(default="github")
    owner: str = APIField(default="")
    name: str = APIField(default="")
    full_name: str = APIField(default="")

    # The shared "location" — branch is the point-in-time picked branch;
    # default_branch is the repo's mainline (for fallback labels in the UI).
    default_branch: str = APIField(default="main")
    branch: str = APIField(default="")
    head_commit: Optional[str] = APIField(default=None)

    # Non-secret metadata; safe to share even for private repos (recipient
    # cannot clone without their own access).
    html_url: str = APIField(default="")
    description: Optional[str] = APIField(default=None)
    private: bool = APIField(default=False)
    fork: bool = APIField(default=False)

    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "GitBranch"

    @property
    def display_name(self) -> str:
        if self.full_name and self.branch:
            return f"{self.full_name} · {self.branch}"
        if self.full_name:
            return self.full_name
        return self.name or ""
