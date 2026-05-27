"""``GET /api/v1/graph/project/<id>/git-state`` — non-destructive snapshot.

Returns the recipient-side git facts the ``GitRepoAcceptModal`` needs to
decide what action to offer (CLONE / CHECKOUT / PULL / COMMIT_AND_PULL /
INCOMPATIBLE_REPO / NO_WORKDIR / UP_TO_DATE):

    {
      "has_repo": bool,
      "remote_full_name": str | null,
      "current_branch": str | null,    # null for detached HEAD
      "has_uncommitted": bool,
      "ahead_of_remote": bool,
      "behind_remote": bool,
      "head_commit": str | null,
      "workdir": str | null,           # absolute path, null when project has none
      "workdir_exists": bool,
    }

Read-only — no subprocess writes anything. Used purely to drive the
modal's state classification reducer.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
from typing import Optional

from flow_sdk.actions import action
from flow_sdk.builtin.project import Project
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse
from flow_sdk.utils.git import (
    find_project_root,
    git_current_branch,
    git_remote_url,
    git_repo_full_name,
)

logger = logging.getLogger(__name__)


def _run(args: list[str], cwd: str, timeout: int = 5) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def _has_uncommitted(repo_path: str) -> bool:
    """True iff ``git status --porcelain`` has any output."""
    try:
        result = _run(["git", "status", "--porcelain"], repo_path)
        return bool(result.returncode == 0 and result.stdout.strip())
    except Exception:
        return False


def _ahead_behind(repo_path: str, branch: str) -> tuple[bool, bool]:
    """Return (ahead, behind) flags by comparing against ``@{upstream}``.

    Returns (False, False) when there's no upstream or the comparison fails —
    those cases are not actionable, so we don't surface PULL just to error.
    """
    if not branch:
        return False, False
    try:
        # Verify the upstream exists first; without it `rev-list` errors noisily.
        upstream = _run(
            ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
            repo_path,
        )
        if upstream.returncode != 0:
            return False, False
        result = _run(
            ["git", "rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            repo_path,
        )
        if result.returncode != 0:
            return False, False
        # Output: "<ahead>\t<behind>"
        parts = result.stdout.strip().split()
        if len(parts) != 2:
            return False, False
        ahead = int(parts[0]) > 0
        behind = int(parts[1]) > 0
        return ahead, behind
    except Exception:
        return False, False


def _head_commit(repo_path: str) -> Optional[str]:
    try:
        result = _run(["git", "rev-parse", "HEAD"], repo_path)
        if result.returncode != 0:
            return None
        sha = result.stdout.strip()
        return sha or None
    except Exception:
        return None


@action.get(action_name="git-state", types=["project"])
async def project_git_state(self: Project) -> ApiResponse:
    workdir = self.fs_storage_mount_path or None
    workdir_exists = bool(workdir and os.path.isdir(workdir))

    if not workdir or not workdir_exists:
        return ApiSuccessResponse(data={
            "has_repo": False,
            "remote_full_name": None,
            "current_branch": None,
            "has_uncommitted": False,
            "ahead_of_remote": False,
            "behind_remote": False,
            "head_commit": None,
            "workdir": workdir,
            "workdir_exists": workdir_exists,
        })

    # All subprocess work runs off the event loop so a slow disk doesn't
    # hold up the request.
    def _gather() -> dict:
        repo_root = find_project_root(workdir)
        if not repo_root:
            return {
                "has_repo": False,
                "remote_full_name": None,
                "current_branch": None,
                "has_uncommitted": False,
                "ahead_of_remote": False,
                "behind_remote": False,
                "head_commit": None,
                "workdir": workdir,
                "workdir_exists": True,
            }
        # Detect remote / branch via the existing helpers.
        remote_full_name = git_repo_full_name(repo_root) or None
        branch = git_current_branch(repo_root) or None  # empty string for detached HEAD
        has_uncommitted = _has_uncommitted(repo_root)
        ahead, behind = _ahead_behind(repo_root, branch or "")
        return {
            "has_repo": True,
            "remote_full_name": remote_full_name,
            "current_branch": branch,
            "has_uncommitted": has_uncommitted,
            "ahead_of_remote": ahead,
            "behind_remote": behind,
            "head_commit": _head_commit(repo_root),
            "workdir": workdir,
            "workdir_exists": True,
        }

    data = await asyncio.to_thread(_gather)
    return ApiSuccessResponse(data=data)
