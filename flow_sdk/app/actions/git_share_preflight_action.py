"""Git-sharing preflight — backend-owned eligibility check for an asset.

  GET /api/v1/graph/<type>/<id>/git_share_preflight

The Share dialog's Git toggle asks this before letting the sender pick Git mode:
can THIS asset be shared by its Git origin (remote + branch + committed HEAD +
repo-relative path) instead of copied bytes? Eligibility is authoritative here —
the frontend never shells git — and packing revalidates the same conditions, so
a stale "available" can only fail the share, never silently ship a copy.

Returns ``{available, reason, code, git_origin}``:
  * ``available`` — True only when the asset is file-backed, lives inside a git
    worktree with a usable ``origin`` remote, on a named branch, at a safe
    repo-relative path, with a clean tree and every commit pushed.
  * ``reason`` — a human-readable, actionable explanation when not available.
  * ``code`` — a stable machine code for the same states (tests / UI branching).
  * ``git_origin`` — the derived ``GitOrigin`` dict when available, else None.

The git reads are the same blocking subprocesses ``GitOrigin.for_asset_path``
runs; they go through ``asyncio.to_thread`` to stay off the event loop.
"""
from __future__ import annotations

import asyncio
import logging

from flow_sdk.actions.action_registry import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.utils.git import _run_git, find_project_root, git_remote_url

logger = logging.getLogger(__name__)


# (code, human reason) — one place so the action, packing, and tests agree.
_REASONS: dict[str, str] = {
    "not-file-backed": "This asset isn't file-backed, so it has no Git origin to share.",
    "not-in-repo": "The asset isn't inside a Git repository.",
    "missing-remote": "The repository has no 'origin' remote to clone from.",
    "unsupported-origin": "The repository's origin isn't a supported Git host.",
    "detached-head": "The repository is in a detached-HEAD state — check out a branch.",
    "no-commit": "The repository has no commits yet — commit the asset first.",
    "dirty": "The repository has uncommitted changes — commit them so they travel.",
    "unpushed": "The branch has unpushed commits — push them so the receiver can clone them.",
    "status-failure": "Couldn't read the repository's Git status.",
}


def _result(code: str | None, git_origin: dict | None = None) -> dict:
    """Build the preflight payload from a reason code (None ⇒ available)."""
    if code is None:
        return {"available": True, "reason": None, "code": None, "git_origin": git_origin}
    return {"available": False, "reason": _REASONS.get(code, code), "code": code, "git_origin": None}


async def _resolve_asset_git_path(entity_type: str, entity_id: str) -> str | None:
    """The on-disk root whose Git repo we probe: the Artifact's ``path`` or a
    file-backed asset's resolved source subtree. None when the type isn't
    file-backed / the asset has no on-disk source."""
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    if entity_type == EntityType.ARTIFACT.value:
        from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415

        artifact = await Artifact.get_one({"id": entity_id})
        path = (getattr(artifact, "path", "") or "").strip() if artifact else ""
        return path or None

    # File-backed asset (skill/spec/agent/…): reuse the pack-time resolver so
    # preflight and packing agree on WHICH subtree defines the origin.
    from flow_sdk.builtin.flow_message_bundle import _resolve_file_backed_source  # noqa: PLC0415

    resolved = await _resolve_file_backed_source(entity_type, entity_id)
    if resolved is None:
        return None
    _info, _ent, src_root = resolved
    return str(src_root) if src_root is not None else None


def _repo_share_status(repo_root: str, origin) -> str | None:
    """Reason code blocking a Git share of a checkout, or None when clean+pushed.

    ``origin`` is the ``GitOrigin`` ``for_asset_path`` already derived — its
    ``head_commit``/``branch`` carry the no-commit / detached-HEAD states, so we
    reuse them instead of re-spawning ``rev-parse``/``branch``. Only the dirty +
    unpushed reads (which the origin doesn't capture) run here. Fail-closed: any
    git read that errors returns ``status-failure``. Sync subprocesses — call in
    a thread.
    """
    if not origin.head_commit:
        return "no-commit"  # nothing to clone yet
    if not origin.branch:
        return "detached-head"  # the share pins a branch; there isn't one
    try:
        # Uncommitted / untracked changes would silently not travel.
        porcelain = _run_git(["git", "status", "--porcelain"], repo_root, timeout=10)
        if porcelain.returncode != 0:
            return "status-failure"
        if porcelain.stdout.strip():
            return "dirty"
        # Commits ahead of the upstream are unclonable by the receiver. No
        # upstream configured ⇒ rev-list exits non-zero ⇒ treat as unpushed.
        ahead = _run_git(["git", "rev-list", "--count", "@{u}..HEAD"], repo_root, timeout=10)
        if ahead.returncode != 0 or (ahead.stdout.strip() or "0") != "0":
            return "unpushed"
        return None
    except Exception:
        logger.debug("[git-preflight] status read failed for %s", repo_root, exc_info=True)
        return "status-failure"


async def git_share_preflight(entity_type: str, entity_id: str) -> dict:
    """Resolve whether ``<type>-<id>`` can be shared by its Git origin.

    Order matters — return the FIRST blocking reason so the sender gets one
    actionable fix at a time (fix the remote before we complain about a dirty
    tree, etc.)."""
    from flow_sdk.builtin.git_origin import GitOrigin  # noqa: PLC0415

    src_root = await _resolve_asset_git_path(entity_type, entity_id)
    if not src_root:
        return _result("not-file-backed")

    repo_root = await asyncio.to_thread(find_project_root, src_root)
    if not repo_root:
        return _result("not-in-repo")

    origin = await asyncio.to_thread(GitOrigin.for_asset_path, src_root, None)
    if origin is None:
        # In a repo but ``for_asset_path`` couldn't build an origin: no usable
        # remote (missing) vs a remote it can't parse/place (unsupported).
        remote = await asyncio.to_thread(git_remote_url, repo_root)
        return _result("missing-remote" if not remote else "unsupported-origin")

    blocking = await asyncio.to_thread(_repo_share_status, repo_root, origin)
    if blocking is not None:
        return _result(blocking)
    return _result(None, git_origin=origin.model_dump(mode="python"))


@action.get(action_name="git_share_preflight", types="all")
async def git_share_preflight_action() -> ApiResponse:
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="No request info found", status_code=400)
    typeid = request_info.target_entity_typeid
    try:
        return ApiSuccessResponse(data=await git_share_preflight(typeid.type, str(typeid.id)))
    except Exception as e:  # noqa: BLE001 — preflight must fail closed, never 500 the dialog
        logger.error("[git-preflight] error for %s: %s", typeid, e, exc_info=True)
        return ApiSuccessResponse(data=_result("status-failure"))
