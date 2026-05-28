"""Four mutating actions on the ``GitRepo`` entity.

Each takes a ``project_typeid`` and runs ``git`` subcommands inside that
project's workdir. Used by the recipient's ``GitRepoAcceptModal`` after it
classifies the local state.

- ``clone-to-project``     → CLONE       (precheck + git clone + git checkout)
- ``checkout-branch``      → CHECKOUT    (git fetch + git checkout)
- ``pull``                 → PULL        (git pull)
- ``commit-and-pull``      → COMMIT_AND_PULL  (git add + commit + pull)

Progress is emitted as ``DataOpMessage`` UPDATE frames against the GitRepo
entity so the modal can subscribe to UPDATE events for that TypeId and
render the latest status line. Throttle is up to the caller — these
actions just emit at natural step boundaries.

Each action returns the final ``project/git-state`` snapshot so the modal
can re-derive the state machine without a follow-up round trip.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
from typing import Any, Awaitable, Callable, Optional

import requests

from flow_sdk.actions import action
from flow_sdk.api.api_request import APIRequest
from flow_sdk.builtin.git_repo import GitRepo
from flow_sdk.builtin.project import Project
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.utils.git import git_clone, git_pull

logger = logging.getLogger(__name__)

StatusEmit = Callable[[str], Awaitable[None]]


def _run(args: list[str], cwd: str, timeout: int = 120) -> subprocess.CompletedProcess:
    # Force English / C output so we can substring-match git's own messages
    # ("nothing to commit", "your branch is ahead", …) regardless of the
    # user's shell locale. Without this, locale-translated output silently
    # bypasses our special cases.
    env = {**os.environ, "LC_ALL": "C", "LANG": "C"}
    return subprocess.run(
        args, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env,
    )


def _make_status_emitter(repo: GitRepo) -> StatusEmit:
    """Return a callable that emits ``DataOpMessage(UPDATE)`` frames on the
    GitRepo's TypeId. Each call adds ``{"status": <text>}`` to the entity's
    payload — the modal subscribes to UPDATE frames for this TypeId and
    renders the latest text as a single status line.
    """
    async def emit(text: str) -> None:
        try:
            from flow_sdk.api.messages import DataOpMessage, OperationType  # noqa: PLC0415
            from flow_sdk.core.network.resource_tracker import handle_entity_op  # noqa: PLC0415
            # Minimal payload — the modal only reads `status`, and the
            # GitRepo's full fields are unchanged across this action's
            # lifecycle. Shipping the whole entity per emit wastes WS bytes.
            payload = {"id": repo.id, "type": repo.type, "status": text}
            await handle_entity_op(
                DataOpMessage(data=payload, op=OperationType.UPDATE, to_entity=repo.typeid)
            )
        except Exception as e:  # noqa: BLE001
            logger.debug("[git_repo] status emit failed (non-fatal): %s", e)

    return emit


async def _load_project(project_typeid: str | None) -> Project | None:
    if not project_typeid:
        return None
    # project_typeid is "project-<uuid>" — strip the type prefix.
    if "-" not in project_typeid:
        return None
    _, _, pid = project_typeid.partition("-")
    return await Project.get_one({"id": pid})


async def _final_state_snapshot(project: Project) -> dict:
    """Return the same shape as ``project/git-state`` so the modal can
    re-derive its state after a successful action."""
    from flow_sdk.app.actions.project_git_state_action import project_git_state  # noqa: PLC0415
    resp = await project_git_state(self=project)
    if isinstance(resp, ApiSuccessResponse) and isinstance(resp.data, dict):
        return resp.data
    return {}


async def _precheck_github_access(repo: GitRepo) -> Optional[str]:
    """Best-effort GitHub API precheck. Returns an error message string when
    the user clearly lacks access; returns ``None`` to mean "proceed".
    Failures of the precheck itself (offline, no token) are treated as
    "proceed" — the actual ``git`` call carries the authoritative auth
    decision via the user's local credential helper.
    """
    if repo.provider != "github" or not repo.full_name:
        return None
    request_info = get_current_request_info()
    if request_info is None:
        return None
    try:
        from flow_sdk.app.actions.repo_actions import (  # noqa: PLC0415
            GithubApiRequestConsts,
            _get_github_token,
            _prepare_github_headers,
        )
    except Exception:  # noqa: BLE001
        return None
    token = await _get_github_token(request_info)
    if not token:
        # Public repos still clone fine via https. Don't block.
        return None
    url = f"{GithubApiRequestConsts.API_BASE_URL}/{repo.full_name}"
    try:
        resp = await asyncio.to_thread(
            requests.get, url, headers=_prepare_github_headers(token),
            timeout=GithubApiRequestConsts.REQUEST_TIMEOUT,
        )
    except Exception:  # noqa: BLE001
        return None
    if resp.status_code in (401, 403):
        return (
            f"No access to {repo.full_name} with the connected GitHub account. "
            "Check the connection or reconnect a different account."
        )
    if resp.status_code == 404:
        return f"{repo.full_name} not found (or access denied) on GitHub."
    return None


async def _resolve_clone_url(repo: GitRepo) -> str:
    """Choose what URL to clone from. Prefer the html_url (works with the
    user's git credential helper for both https and ssh). Fall back to
    constructing a github.com URL from full_name."""
    if repo.html_url:
        return repo.html_url
    if repo.provider == "github" and repo.full_name:
        return f"https://github.com/{repo.full_name}"
    return ""


async def _ensure_workdir(project: Project, emit: StatusEmit) -> Optional[ApiResponse]:
    """Return an ApiFailResponse if the project's workdir is unusable, else None."""
    workdir = project.fs_storage_mount_path
    if not workdir:
        await emit("Project has no workdir set.")
        return ApiFailResponse(message="Project has no workdir set; configure it in project settings first.")
    return None


# ── clone-to-project ────────────────────────────────────────────────────────


@action.post(action_name="clone-to-project", types=["git_repo"])
async def clone_to_project(self: GitRepo) -> ApiResponse:
    request_info = get_current_request_info()
    body = (await request_info.get_post_data()) if request_info else {}
    project_typeid = (body or {}).get("project_typeid")
    project = await _load_project(project_typeid)
    if project is None:
        return ApiFailResponse(message="project_typeid required and must resolve to a Project")

    emit = _make_status_emitter(self)
    err = await _ensure_workdir(project, emit)
    if err:
        return err

    await emit(f"Checking access to {self.full_name}…")
    access_err = await _precheck_github_access(self)
    if access_err:
        await emit(access_err)
        return ApiFailResponse(message=access_err)

    clone_url = await _resolve_clone_url(self)
    if not clone_url:
        return ApiFailResponse(message="Could not determine clone URL")

    target = project.fs_storage_mount_path
    # git_clone refuses if target exists and is non-empty. If the target
    # exists but is empty, clone into it; if non-empty, surface the error.
    if os.path.isdir(target) and os.listdir(target):
        msg = f"{target} is not empty — cannot clone here without overwriting."
        await emit(msg)
        return ApiFailResponse(message=msg)

    await emit(f"Cloning {self.full_name}…")
    ok, msg = await git_clone(clone_url, target, branch=self.branch or None)
    if not ok:
        await emit(f"Clone failed: {msg}")
        return ApiFailResponse(message=msg)

    # `git clone --branch <X>` already checks out X; the post-clone branch
    # is X. Skip a redundant checkout. The final state-snapshot proves it.
    await emit("Done.")
    snapshot = await _final_state_snapshot(project)
    return ApiSuccessResponse(data={"message": msg, "git_state": snapshot})


# ── checkout-branch ─────────────────────────────────────────────────────────


@action.post(action_name="checkout-branch", types=["git_repo"])
async def checkout_branch(self: GitRepo) -> ApiResponse:
    request_info = get_current_request_info()
    body = (await request_info.get_post_data()) if request_info else {}
    project_typeid = (body or {}).get("project_typeid")
    project = await _load_project(project_typeid)
    if project is None:
        return ApiFailResponse(message="project_typeid required and must resolve to a Project")
    emit = _make_status_emitter(self)
    err = await _ensure_workdir(project, emit)
    if err:
        return err
    workdir = project.fs_storage_mount_path
    if not self.branch:
        return ApiFailResponse(message="GitRepo has no branch to check out")

    await emit("Fetching…")
    fetch = await asyncio.to_thread(_run, ["git", "fetch"], workdir, 30)
    if fetch.returncode != 0:
        msg = (fetch.stderr or fetch.stdout or "").strip() or "git fetch failed"
        await emit(f"Fetch failed: {msg}")
        return ApiFailResponse(message=msg)

    await emit(f"Checking out {self.branch}…")
    chk = await asyncio.to_thread(_run, ["git", "checkout", self.branch], workdir, 30)
    if chk.returncode != 0:
        msg = (chk.stderr or chk.stdout or "").strip() or "git checkout failed"
        await emit(f"Checkout failed: {msg}")
        return ApiFailResponse(message=msg)

    await emit("Done.")
    snapshot = await _final_state_snapshot(project)
    return ApiSuccessResponse(data={"message": "Checked out.", "git_state": snapshot})


# ── pull ────────────────────────────────────────────────────────────────────


@action.post(action_name="pull", types=["git_repo"])
async def pull(self: GitRepo) -> ApiResponse:
    request_info = get_current_request_info()
    body = (await request_info.get_post_data()) if request_info else {}
    project_typeid = (body or {}).get("project_typeid")
    project = await _load_project(project_typeid)
    if project is None:
        return ApiFailResponse(message="project_typeid required and must resolve to a Project")
    emit = _make_status_emitter(self)
    err = await _ensure_workdir(project, emit)
    if err:
        return err

    await emit(f"Pulling {self.branch or 'origin'}…")
    ok, msg = await git_pull(project.fs_storage_mount_path, branch=self.branch or None)
    if not ok:
        await emit(f"Pull failed: {msg}")
        return ApiFailResponse(message=msg)

    await emit("Done.")
    snapshot = await _final_state_snapshot(project)
    return ApiSuccessResponse(data={"message": msg, "git_state": snapshot})


# ── commit-and-pull ─────────────────────────────────────────────────────────


@action.post(action_name="commit-and-pull", types=["git_repo"])
async def commit_and_pull(self: GitRepo) -> ApiResponse:
    request_info = get_current_request_info()
    body = (await request_info.get_post_data()) if request_info else {}
    project_typeid = (body or {}).get("project_typeid")
    message = ((body or {}).get("message") or "").strip()
    if not message:
        return ApiFailResponse(message="Commit message required")
    project = await _load_project(project_typeid)
    if project is None:
        return ApiFailResponse(message="project_typeid required and must resolve to a Project")
    emit = _make_status_emitter(self)
    err = await _ensure_workdir(project, emit)
    if err:
        return err
    workdir = project.fs_storage_mount_path

    await emit("Staging changes…")
    add = await asyncio.to_thread(_run, ["git", "add", "-A"], workdir, 30)
    if add.returncode != 0:
        msg = (add.stderr or add.stdout or "").strip() or "git add failed"
        await emit(f"Stage failed: {msg}")
        return ApiFailResponse(message=msg)

    await emit("Committing…")
    commit = await asyncio.to_thread(_run, ["git", "commit", "-m", message], workdir, 30)
    if commit.returncode != 0:
        # `git commit` with nothing staged exits 1 — surface a cleaner
        # message rather than the raw "nothing to commit" string.
        out = (commit.stderr or commit.stdout or "").strip()
        if "nothing to commit" in out.lower():
            await emit("Nothing to commit; pulling…")
        else:
            await emit(f"Commit failed: {out}")
            return ApiFailResponse(message=out or "git commit failed")

    await emit(f"Pulling {self.branch or 'origin'}…")
    ok, msg = await git_pull(workdir, branch=self.branch or None)
    if not ok:
        await emit(f"Pull failed: {msg}")
        return ApiFailResponse(message=msg)

    await emit("Done.")
    snapshot = await _final_state_snapshot(project)
    return ApiSuccessResponse(data={"message": msg, "git_state": snapshot})
