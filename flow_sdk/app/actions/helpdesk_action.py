"""HTTP actions for the helpdesk PORTAL — the local checkout of a desk's help
content.

Distinct from the ticket queue (``flow_message_action``'s
``helpdesk-start-ticket`` / ``helpdesk-tickets-list``), which talks to the hub.
A desk answers tickets on the hub AND publishes a portal repo that requesters
clone locally; the two are configured separately and either may be absent.

POST /api/v1/graph/helpdesk-ensure    — checkout exists (clone if missing)
POST /api/v1/graph/helpdesk-refresh   — hard-sync the portal repo to its remote
POST /api/v1/graph/helpdesk-reset     — dev: drop the local checkout entirely

The three actions map onto the steps of the UI load flow, so each renders as
one checklist row.
"""

import logging
import shutil
from functools import wraps
from pathlib import Path

from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.git_origin import GitOrigin
from flow_sdk.builtin.project import Project
from flow_sdk.config import HELPDESK_PORTAL_UNAME, StorageProvider, helpdesk_project_dir
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.utils.git import git_clone, git_sync_mirror

logger = logging.getLogger(__name__)


class _NoDesk(Exception):
    """No desk is configured — the one failure every action here shares."""


def _helpdesk_action(failure: str):
    """Wrap an action body with the try/except every action in this module needs.

    Each one has the same shape: resolve the desk, do its work, and turn an
    unexpected exception into a FAIL carrying its own verb. Factored so the
    three bodies contain only their distinct work, and so the "unavailable"
    message exists once instead of being three literals that must agree.
    """

    def decorate(fn):
        @wraps(fn)
        async def wrapper(*args, **kwargs) -> ApiResponse:
            try:
                return await fn(*args, **kwargs)
            except _NoDesk:
                # Upstream has no desk; our backend is healthy, hence 502.
                return ApiFailResponse(message="Help desk is unavailable on this hub", status_code=502)
            except Exception as e:  # noqa: BLE001
                logger.error("[helpdesk_action] %s: %s", fn.__name__, e, exc_info=True)
                return ApiFailResponse(message=f"{failure}: {str(e)}")

        return wrapper

    return decorate


async def _require_target():
    """The desk this instance points at; raises ``_NoDesk`` when there is none.

    The chain logic lives in ``flow_message_action.resolve_helpdesk``.
    """
    from flow_sdk.app.actions.flow_message_action import resolve_helpdesk  # noqa: PLC0415

    target = await resolve_helpdesk()
    if not target:
        raise _NoDesk
    return target


def _is_checkout(mount_path: Path) -> bool:
    """Whether ``mount_path`` holds a git checkout (as opposed to nothing, or a
    leftover directory from an interrupted clone)."""
    return (mount_path / ".git").is_dir()


def _portal_paths(target) -> tuple[Path, str]:
    """``(mount_path, canonical)`` for a desk's checkout slot.

    Both forms are needed at nearly every call site — ``Path`` for filesystem
    work, the canonical posix string for storing and for entity lookup — and
    deriving them separately in each action was how they drifted.
    """
    mount_path = helpdesk_project_dir(target.project_id)
    return mount_path, canonical_posix_path(str(mount_path))


async def _adopted_desk_payload(project_id: str) -> dict | None:
    """The desk THIS project adopted, or ``None`` to fall back to the hub's.

    A project can carry a vendor's help desk as an ordinary context folder: the
    folder is a repo the vendor publishes, and indexing it discovers the
    ``Helpdesk`` inside (see ``builtin/helpdesk.py``). That desk is the one the
    project's own people should reach — a customer working in an engagement
    wants their vendor's desk, not ours. Only when a project has adopted
    nothing do we fall through to the instance-wide desk the hub advertises.

    Nothing is cloned or minted here. The context folder is already on disk
    (attaching it is what put it there) and the workspace walk has already
    minted the Project that owns that directory, so this is pure resolution —
    which is also why it is safe to run on every open.
    """
    from flow_sdk.builtin.helpdesk import Helpdesk  # noqa: PLC0415

    project = await Project.get_by_id(project_id)
    if project is None:
        return None
    roots = [canonical_posix_path(d) for d in (project.include_dirs or [])]
    if not roots:
        return None

    for desk in await Helpdesk.get_all():
        if not desk.asset_ref:
            continue
        ref = canonical_posix_path(desk.asset_ref)
        root = next((r for r in roots if ref == r or ref.startswith(r.rstrip("/") + "/")), None)
        if root is None:
            continue
        portal = await Project.find_by_cwd(root)
        if portal is None:
            # The directory is attached but no Project owns it yet (the walk
            # has not caught up). Fall back rather than minting one here —
            # ``helpdesk-ensure`` is on the open path and must stay cheap.
            continue
        return {
            "project_id": portal.id,
            "helpdesk_project_id": desk.desk_project_id,
            "mount_path": root,
            "cloned": False,
            "has_portal": True,
            # Lets the caller skip the fetch/index steps: this checkout is a
            # context folder the project already resolved and indexed, not a
            # portal slot this action owns.
            "adopted": True,
        }
    return None


def _ensure_payload(target, *, project_id=None, mount_path=None, cloned=False) -> dict:
    """The ``helpdesk-ensure`` response. One builder so the has-portal and
    no-portal shapes cannot drift apart."""
    return {
        "project_id": project_id,
        "helpdesk_project_id": target.project_id,
        "mount_path": mount_path,
        "cloned": cloned,
        "has_portal": project_id is not None,
    }


@action.post(action_name="helpdesk-ensure", types=None)
@_helpdesk_action("Failed to prepare the help desk")
async def helpdesk_ensure(project_id: str = "") -> ApiResponse:
    """The portal checkout exists, cloning it on first run. Idempotent.

    ``project_id`` is the project the user is working in. If that project has
    adopted a desk of its own — a vendor's help desk attached as a context
    folder — that desk wins, and nothing here clones anything: the folder is
    already on disk. Only a project with no desk of its own falls through to
    the instance-wide desk the hub advertises. That is what makes support tiers
    chain: A's desk serves A's own projects while B, working inside a project
    A set up, reaches A.

    For that fall-through case, placement is the fixed per-desk slot
    ``helpdesk_project_dir`` — NOT ``GitOrigin.next_clone_target``. The portal
    is app-managed infrastructure keyed by desk id, not a user project the
    recipient chose to take, so it must land in the same deterministic spot
    every time (which is also what lets ``helpdesk-reset`` know exactly what to
    remove).
    """
    request_info = get_current_request_info()
    if not request_info or not request_info.someone_typeid:
        return ApiFailResponse(message="No authenticated user in request context")

    if project_id:
        adopted = await _adopted_desk_payload(project_id)
        if adopted is not None:
            return ApiSuccessResponse(data=adopted)

    target = await _require_target()
    if not target.portal_git_url:
        # A desk with a ticket queue and NO portal is a valid configuration (see
        # HelpdeskConfig) — and it is also what an older hub looks like, since it
        # advertises no portal url at all. Report it as a SUCCESS carrying
        # ``has_portal: false`` so the caller can degrade to the ticket flow;
        # failing here would make the help desk unreachable on any hub that
        # predates the portal field.
        return ApiSuccessResponse(data=_ensure_payload(target))

    mount_path, canonical = _portal_paths(target)
    cloned = False

    if not _is_checkout(mount_path):
        # A leftover non-repo dir (interrupted clone) would make git refuse to
        # clone into it, and would keep failing on every retry.
        if mount_path.exists():
            shutil.rmtree(mount_path, ignore_errors=True)
        mount_path.parent.mkdir(parents=True, exist_ok=True)

        token = None
        try:
            from flow_sdk.app.actions.oauth_action import (  # noqa: PLC0415
                _get_github_token_for_current_user,
            )

            token, _ = await _get_github_token_for_current_user()
        except Exception:  # noqa: BLE001
            # The portal is expected to be public; a missing token is normal.
            token = None

        ok, message = await git_clone(target.portal_git_url, str(mount_path), token=token)
        if not ok:
            return ApiFailResponse(message=message, status_code=502)
        cloned = True

    proj = await Project.find_by_cwd(canonical)
    if proj is None:
        proj = Project(
            type="project",
            # Stable uname so any surface can recognise the portal from the
            # entity it already holds — no probe. Hiddenness is NOT stamped
            # here: `is_hidden_project` derives it from the location
            # (`is_helpdesk_portal_path`), which also covers rows minted by the
            # per-cwd project walk.
            uname=HELPDESK_PORTAL_UNAME,
            name="Help Desk",
            fs_storage_mount_path=canonical,
            fs_storage_provider=StorageProvider.LOCAL.value,
            visitor_role="owner",
            git_origin=GitOrigin.from_url(target.portal_git_url, rel_path="."),
        )
        await proj.save(request_info.someone_typeid)
        # Mirrors `_ensure_system_projects`: the field alone does not establish
        # the role, so the app-managed-project recipe saves AND then applies it.
        await proj.set_visitor_role("owner")

    return ApiSuccessResponse(
        data=_ensure_payload(target, project_id=proj.id, mount_path=canonical, cloned=cloned)
    )


@action.post(action_name="helpdesk-refresh", types=None)
@_helpdesk_action("Failed to refresh the help desk")
async def helpdesk_refresh() -> ApiResponse:
    """Make the local portal match the remote.

    A hard sync, not a pull. Indexing STAMPS every markdown file in the
    checkout with its entity id, so the working tree is dirty the moment the
    portal is first indexed and a plain pull aborts on "local changes would be
    overwritten" — the desk would silently stop receiving content updates after
    its first open. Nothing here is the user's work: the portal is a mirror of a
    repo they do not edit, and the stamps are re-applied by the next index.
    """
    target = await _require_target()
    mount_path, _ = _portal_paths(target)
    if not _is_checkout(mount_path):
        return ApiFailResponse(message="Help desk files are not set up yet", status_code=409)

    ok, changed, message = await git_sync_mirror(str(mount_path))
    if not ok:
        return ApiFailResponse(message=message, status_code=502)
    # ``changed`` comes back explicitly — the caller must not re-derive "is a
    # re-index due?" by matching English in ``message``.
    return ApiSuccessResponse(data={"updated": changed, "message": message})


@action.post(action_name="helpdesk-reset", types=None)
@_helpdesk_action("Failed to reset the help desk")
async def helpdesk_reset() -> ApiResponse:
    """Drop the local portal entirely so the next open re-clones from scratch.

    Local only — the hub desk and its tickets are untouched. Deletes the Project
    entity, its child entities, and the on-disk folder via
    ``Project._delete_with_children``; the folder lives under the workspace, so
    it is neither protected nor SDK-shipped and really is removed. Exposed in
    the UI behind a dev-mode gate.
    """
    request_info = get_current_request_info()
    if not request_info or not request_info.someone_typeid:
        return ApiFailResponse(message="No authenticated user in request context")

    target = await _require_target()
    mount_path, canonical = _portal_paths(target)

    proj = await Project.find_by_cwd(canonical)
    if proj is not None:
        await proj._delete_with_children()

    # Belt to the entity delete's braces: with no Project row (e.g. a clone that
    # failed before the entity was saved) nothing above touches disk, and the
    # stale folder would make the next `ensure` skip its clone.
    if mount_path.is_dir():
        shutil.rmtree(mount_path, ignore_errors=True)

    return ApiSuccessResponse(data={"deleted": True, "mount_path": canonical})
