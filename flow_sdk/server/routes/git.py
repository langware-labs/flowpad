"""Git routes — questions about a REMOTE repo, answered by the git lib.

Only one today: "can I read this repo, and what's its default branch?", which
the New-desktop / New-project-from-git dialogs ask before they commit to a
clone. It runs the same credential path ``git_clone`` uses (anonymous, or the
caller's GitHub token from SOD), so a passing check and a working clone can
never disagree — and no generic HTTP proxy has to exist for the frontend to
reach github.com.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Request

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/git")


@router.post("/remote-access")
async def remote_access(request: Request):
    """``{clone_url}`` → ``{accessible, default_branch}``.

    Never 4xx's on a private repo — "not accessible" is an answer, not an
    error; the caller turns it into the "connect GitHub to continue" gate.
    """
    from flow_sdk.app.actions.oauth_action import _get_github_token_for_current_user
    from flow_sdk.utils.git import git_remote_access

    body = await request.json()
    clone_url = (body or {}).get("clone_url") or ""
    if not clone_url:
        return ApiFailResponse(message="clone_url is required", status_code=400)

    token = await _get_github_token_for_current_user()
    accessible, default_branch = await git_remote_access(clone_url, token=token)
    return ApiSuccessResponse(data={"accessible": accessible, "default_branch": default_branch})
