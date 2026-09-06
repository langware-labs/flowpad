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

The module also owns the mirror-image question, for the RECEIVING end:

  GET /api/v1/graph/<type>/<id>/git_anonymous_access

``{public, repo, clone_url, code, reason}`` — could a stranger clone this repo?
Preflight says the sender may publish; this says whether anyone they publish to
will be able to read it. See ``git_anonymous_access``.

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
    "unresolved-folder": "This folder isn't set up on this machine yet.",
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
    # The origin rides along on the failure branch too when we managed to derive
    # one. "Can't share yet" and "has no repo" are different states, and a
    # caller that only wants to NAME the repo (a header chip) shouldn't have to
    # wait for the tree to be clean and pushed before it can show it.
    return {
        "available": False,
        "reason": _REASONS.get(code, code),
        "code": code,
        "git_origin": git_origin,
    }


async def _entity_local_path(cls, entity_id: str) -> str | None:
    """Resolve a graph entity's local path from its stored origin or path."""
    from pathlib import Path  # noqa: PLC0415

    ent = await cls.get_one({"id": entity_id})
    if ent is None:
        return None
    # A locally-minted or already-resolved entity caches its on-disk ``path``.
    # When that path still exists it is the authoritative "this machine"
    # location for EVERY origin kind — a git-origin folder minted here from a
    # local worktree is present even if its repo was never opened as a Claude
    # project (so ``find_local_repo_for_url`` can't re-derive it). Prefer the
    # cached path so preflight probes the live tree's CURRENT git state instead
    # of falsely reporting the folder unresolved.
    cached = (getattr(ent, "path", "") or "").strip()
    if cached and Path(cached).exists():
        return cached
    origin = getattr(ent, "origin", None)
    if getattr(origin, "kind", None) == "local":
        return str(Path(origin.base) / (origin.rel_path or "."))
    if getattr(origin, "kind", None) == "git":
        from flow_sdk.utils.git import find_local_repo_for_url  # noqa: PLC0415

        repo = await asyncio.to_thread(find_local_repo_for_url, origin.clone_url())
        return str(Path(repo) / (origin.rel_path or ".")) if repo else None
    return cached or None


async def _resolve_asset_git_path(entity_type: str, entity_id: str) -> str | None:
    """The on-disk root whose Git repo we probe.

    Graph entities (artifact / folder) carry their own local ``path`` — they sit
    outside the file-backed registry (a Folder has no ``asset_ref`` BY DESIGN:
    generic destructive paths rmtree asset_ref targets, see folder_type_info).
    Probing that live path is also what makes a directory git-init'd after the
    entity was minted report its CURRENT state rather than its stale origin.
    Everything else resolves through the registry. None when the type has no
    on-disk source concept, or the instance has no path yet.
    """
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    if entity_type == EntityType.ARTIFACT.value:
        from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415

        return await _entity_local_path(Artifact, entity_id)

    if entity_type == EntityType.FOLDER.value:
        from flow_sdk.builtin.folder import Folder  # noqa: PLC0415

        return await _entity_local_path(Folder, entity_id)

    if entity_type == EntityType.PROJECT.value:
        # A Project is not file-backed, but it is a DIRECTORY — its mount is the
        # tree to ask about. Without this it fell through to the file-backed
        # resolver, came back empty, and every project answered
        # "isn't file-backed, so it has no Git origin to share" — an asset-share
        # sentence that says nothing about a project and hid the real state
        # (no repo? no remote? unpushed?) from the project header's Git chip.
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await Project.get_one({"id": entity_id})
        mount = (getattr(project, "fs_storage_mount_path", "") or "").strip() if project else ""
        return mount or None

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
    from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    src_root = await _resolve_asset_git_path(entity_type, entity_id)
    if not src_root:
        # A Folder IS file-backed — it just has no local path yet (e.g. received
        # but never resolved). Saying "isn't file-backed" there would be a lie.
        return _result("unresolved-folder" if entity_type == EntityType.FOLDER.value else "not-file-backed")

    # One cache for every git read below: `for_asset_path` re-walks for the repo
    # root and re-reads the remote otherwise, duplicating both this walk and a
    # `git remote get-url` subprocess on the missing-remote path.
    repo_cache: dict = {}
    repo_root = await asyncio.to_thread(find_project_root, src_root)
    if not repo_root:
        return _result("not-in-repo")

    origin = await asyncio.to_thread(GitOrigin.for_asset_path, src_root, repo_cache)
    if origin is None:
        # In a repo but ``for_asset_path`` couldn't build an origin: no usable
        # remote (missing) vs a remote it can't parse/place (unsupported).
        remote = await asyncio.to_thread(git_remote_url, repo_root)
        return _result("missing-remote" if not remote else "unsupported-origin")

    blocking = await asyncio.to_thread(_repo_share_status, repo_root, origin)
    if blocking is not None:
        return _result(blocking, git_origin=origin.model_dump(mode="python"))
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


async def git_anonymous_access(entity_type: str, entity_id: str) -> dict:
    """Could someone with NO GitHub credential clone this asset's repository?

    The sender-side question ``git_share_preflight`` cannot answer. Preflight is
    about whether the sender's tree is publishable; this is about whether the
    people on the other end will be able to read what was published. A private
    repo shares perfectly well and then fails to open for every recipient who
    isn't already a collaborator on it — Flowpad grants Flowpad membership, never
    GitHub access — so the admin doing the sharing is told before, not after.

    The probe is ``git ls-remote`` with the caller's own credential helpers
    switched off (``ignore_local_credentials``). That is the whole point: run
    with them, the admin's keychain answers and every repo they can read looks
    public.

    Returns ``{public, repo, clone_url, code, reason}`` where ``public`` is
    ``None`` when there is no repository to ask about (``code`` says why).
    """
    from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415
    from flow_sdk.utils.git import git_remote_access  # noqa: PLC0415

    def _unknown(code: str) -> dict:
        return {"public": None, "repo": None, "clone_url": None, "code": code, "reason": _REASONS.get(code, code)}

    src_root = await _resolve_asset_git_path(entity_type, entity_id)
    if not src_root:
        return _unknown("unresolved-folder" if entity_type == EntityType.FOLDER.value else "not-file-backed")

    repo_cache: dict = {}
    repo_root = await asyncio.to_thread(find_project_root, src_root)
    if not repo_root:
        return _unknown("not-in-repo")

    origin = await asyncio.to_thread(GitOrigin.for_asset_path, src_root, repo_cache)
    if origin is None:
        remote = await asyncio.to_thread(git_remote_url, repo_root)
        return _unknown("missing-remote" if not remote else "unsupported-origin")

    clone_url = origin.clone_url()
    reachable, _branch = await git_remote_access(clone_url, ignore_local_credentials=True)
    return {
        "public": bool(reachable),
        "repo": f"{origin.owner}/{origin.name}",
        "clone_url": clone_url,
        "code": None,
        "reason": None,
    }


@action.get(action_name="git_anonymous_access", types="all")
async def git_anonymous_access_action() -> ApiResponse:
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="No request info found", status_code=400)
    typeid = request_info.target_entity_typeid
    try:
        return ApiSuccessResponse(data=await git_anonymous_access(typeid.type, str(typeid.id)))
    except Exception as e:  # noqa: BLE001 — an unreadable remote must not 500 the dialog
        logger.error("[git-anon] error for %s: %s", typeid, e, exc_info=True)
        return ApiSuccessResponse(
            data={
                "public": None,
                "repo": None,
                "clone_url": None,
                "code": "status-failure",
                "reason": _REASONS["status-failure"],
            }
        )
