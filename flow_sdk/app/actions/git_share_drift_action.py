"""A received git share after it arrived: is there a newer version, take it,
or send the receiver's own edits back.

  GET  /api/v1/graph/<type>/<id>/git_share_status     → behind / edited
  POST /api/v1/graph/<type>/<id>/git_share_update     → open the branch's latest
  POST /api/v1/graph/<type>/<id>/git_share_send_back  → push edits to share/<who>/<leaf>

The received row's origin pins the commit it was shared at; its ``asset_ref``
sits in a checkout of that commit (a detached worktree, or the receiver's own
clone when it already sat there). Nothing here touches any other checkout the
receiver owns, and nothing is ever force-pushed. An update never discards the
receiver's edits: an edited copy is refused with ``code="local-edits"`` until
the edits are sent back (or the person chooses to keep the old version).
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.drivers.git_driver import path_is_clean, remove_share_slot, run_git
from flow_sdk.builtin.git_share_specs import GitShareSendBack
from flow_sdk.fs_store.origin.git_origin import _sanitize_leaf
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _Received:
    """A received git share: its row, pinned origin, and the checkout it sits in."""

    row: object
    origin: object
    root: Path

    @property
    def rel(self) -> str:
        return self.origin.rel_path or "."


async def _received(entity_type: str, entity_id: str) -> _Received | None:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.utils.git import find_project_root  # noqa: PLC0415

    cls = SchemaRegistry.get_entity_cls(entity_type)
    row = await cls.get_one({"id": entity_id}) if cls is not None else None
    origin = getattr(row, "origin", None)
    ref = (getattr(row, "asset_ref", "") or "").strip()
    if row is None or getattr(origin, "kind", None) != "git" or not getattr(origin, "head_commit", None) or not ref:
        return None
    start = ref if Path(ref).is_dir() else str(Path(ref).parent)
    root = await asyncio.to_thread(find_project_root, start)
    return _Received(row, origin, Path(root)) if root else None


#: When each (checkout, branch) was last fetched. The bar asks for status on
#: every view of a received asset; the network is asked at most once a minute.
_FETCHED: dict[tuple[str, str], float] = {}
_FETCH_EVERY_S = 60.0


def _status(got: _Received, *, fresh: bool = False) -> dict:
    """How far the shared branch moved past the pinned commit (counting only
    commits that touch the asset), and whether the receiver edited it.
    ``fresh`` fetches now; otherwise a fetch younger than a minute is reused."""
    origin, root, rel = got.origin, got.root, got.rel
    commit = origin.head_commit
    latest, behind = commit, 0
    if origin.branch:
        key = (str(root), origin.branch)
        if fresh or time.monotonic() - _FETCHED.get(key, float("-inf")) > _FETCH_EVERY_S:
            if run_git(root, "fetch", "-q", "origin", origin.branch).returncode == 0:
                _FETCHED[key] = time.monotonic()
        tip = run_git(root, "rev-parse", "--verify", "-q", f"refs/remotes/origin/{origin.branch}").stdout.strip()
        if tip:
            latest = tip
            counted = run_git(root, "rev-list", "--count", f"{commit}..{tip}", "--", rel)
            behind = int(counted.stdout.strip() or "0") if counted.returncode == 0 else 0
    return {
        "commit": commit,
        "branch": origin.branch or None,
        "latest": latest,
        "behind": behind,
        "edited": not path_is_clean(root, rel),
    }


async def git_share_status(entity_type: str, entity_id: str) -> dict:
    got = await _received(entity_type, entity_id)
    if got is None:
        return {"shared": False}
    return {"shared": True, **await asyncio.to_thread(_status, got)}


async def git_share_update(entity_type: str, entity_id: str) -> dict:
    """Open the shared branch's latest version of the asset, in place of the
    pinned one, and drop the old (clean) share slot."""
    from flow_sdk.builtin.flow_message_bundle import reopen_git_share  # noqa: PLC0415
    from flow_sdk.builtin.fs_origin_driver import get_origin_driver  # noqa: PLC0415

    got = await _received(entity_type, entity_id)
    if got is None:
        return {"updated": False, "code": "not-shared"}
    status = await asyncio.to_thread(_status, got, fresh=True)
    if status["edited"]:
        return {"updated": False, "code": "local-edits", **status}
    if not status["behind"]:
        return {"updated": False, "code": "up-to-date", **status}
    newer = got.origin.model_copy(update={"head_commit": status["latest"]})
    local_root, project_id = await get_origin_driver(newer.kind).materialize_pinned(
        newer, preferred_root=got.root, preferred_project_id=getattr(got.row, "project_id", None)
    )
    if local_root.resolve() != got.root.resolve():
        # The old version's slot is ours and was just checked clean: drop it, so
        # the asset has one place on disk (and one in the index).
        await asyncio.to_thread(remove_share_slot, got.root)
    asset_ref = await reopen_git_share(entity_type, entity_id, newer, local_root, project_id)
    return {
        "updated": True,
        "code": None,
        **status,
        "commit": status["latest"],
        "behind": 0,
        "asset_ref": str(asset_ref),
    }


async def git_share_send_back(entity_type: str, entity_id: str, sender: str, message: str | None = None) -> dict:
    """Commit the receiver's edits to the shared asset on ``share/<sender>/<leaf>``
    and push that branch — the sender's branch is never written."""
    from flow_sdk.builtin.faas.git_repo import GitRepo  # noqa: PLC0415

    got = await _received(entity_type, entity_id)
    if got is None:
        return {"sent": False, "code": "not-shared"}
    root, rel = got.root, got.rel
    leaf = _sanitize_leaf(Path(rel).name, "asset")
    branch = f"share/{_sanitize_leaf(sender, 'receiver')}/{leaf}"
    if root.parent.name != ".shared":
        # The share opened in the receiver's OWN checkout (it already sat at the
        # commit): its branch is theirs, and switching it is not ours to do.
        return {"sent": False, "code": "own-checkout", "branch": branch}
    if await asyncio.to_thread(path_is_clean, root, rel):
        return {"sent": False, "code": "no-edits", "branch": branch}
    switched = await asyncio.to_thread(run_git, root, "checkout", "-q", "-B", branch)
    if switched.returncode != 0:
        return {"sent": False, "code": "git-failed", "message": switched.stderr.strip(), "branch": branch}
    pushed = await (await GitRepo.local(str(root))).push(
        paths=[rel], message=message or f"Edits to {leaf} from {sender}"
    )
    if not pushed.ok:
        return {"sent": False, "code": pushed.kind, "message": pushed.message, "branch": branch}
    return {"sent": True, "code": None, "branch": branch, "commit": pushed.sha}


def _target_typeid():
    info = get_current_request_info()
    return info, (info.target_entity_typeid if info else None)


def _no_target() -> ApiResponse:
    return ApiFailResponse(message="No request info found", status_code=400)


@action.get(action_name="git_share_status", types="all")
async def git_share_status_action() -> ApiResponse:
    _info, typeid = _target_typeid()
    if typeid is None:
        return _no_target()
    return ApiSuccessResponse(data=await git_share_status(typeid.type, str(typeid.id)))


@action.post(action_name="git_share_update", types="all")
async def git_share_update_action() -> ApiResponse:
    _info, typeid = _target_typeid()
    if typeid is None:
        return _no_target()
    return ApiSuccessResponse(data=await git_share_update(typeid.type, str(typeid.id)))


@action.post(action_name="git_share_send_back", types="all")
async def git_share_send_back_action() -> ApiResponse:
    info, typeid = _target_typeid()
    if typeid is None:
        return _no_target()
    try:
        body = GitShareSendBack.model_validate(await info.get_post_data() or {})
    except ValidationError as e:
        return ApiFailResponse(message=f"Invalid send back: {e}", status_code=400)
    return ApiSuccessResponse(data=await git_share_send_back(typeid.type, str(typeid.id), body.sender, body.message))
