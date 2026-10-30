"""A received git share after it arrived: has the shared branch moved on, and
bring the newer version into the receiver's checkout.

  GET  /api/v1/graph/<type>/<id>/git_share_status  → behind / edited
  POST /api/v1/graph/<type>/<id>/git_share_update  → the plan; ``{"apply": true}`` runs it

A received share lives in the receiver's OWN checkout (``GitOriginDriver.receive``),
so a newer version comes in the way any change does — a pull on the shared
branch, a cherry-pick anywhere else — and the receiver's own edits go back the
way any edit does (commit, push, or share it back). Nothing is force-pushed.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from pathlib import Path

from flow_sdk.actions.action_registry import action
from pydantic import ValidationError

from flow_sdk.builtin.drivers.git_driver import (
    GitShareError,
    NeedsApply,
    missing_commits,
    path_is_clean,
    run_git,
    share_consent,
)
from flow_sdk.builtin.git_share_specs import GitShareApply
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _Received:
    """A received git share: its row, origin, and the checkout it lives in."""

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
    """How many commits on the shared branch change the asset and are not on the
    receiver's branch yet (a commit already cherry-picked counts as there), the
    newest of them, and whether the receiver has uncommitted edits to it.
    ``fresh`` fetches now; otherwise a fetch younger than a minute is reused."""
    origin, root, rel = got.origin, got.root, got.rel
    latest, behind = origin.head_commit, 0
    if origin.branch:
        key = (str(root), origin.branch)
        if fresh or time.monotonic() - _FETCHED.get(key, float("-inf")) > _FETCH_EVERY_S:
            if run_git(root, "fetch", "-q", "origin", origin.branch).returncode == 0:
                _FETCHED[key] = time.monotonic()
        tip = f"refs/remotes/origin/{origin.branch}"
        if run_git(root, "rev-parse", "--verify", "-q", tip).returncode == 0:
            ids = missing_commits(root, tip, rel)
            behind = len(ids)
            if ids:
                latest = ids[-1]  # oldest first: the last is the newest
    return {
        "commit": origin.head_commit,
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


async def git_share_update(entity_type: str, entity_id: str, *, apply: bool = False) -> dict:
    """Bring the shared branch's newer version of the asset into the receiver's
    checkout. Without ``apply`` it answers the plan (``needs: "apply"``) and
    writes nothing; with it, the pull / cherry-pick runs."""
    from flow_sdk.builtin.flow_message_bundle import reopen_git_share  # noqa: PLC0415
    from flow_sdk.builtin.fs_origin_driver import get_origin_driver  # noqa: PLC0415

    got = await _received(entity_type, entity_id)
    if got is None:
        return {"updated": False, "code": "not-shared"}
    status = await asyncio.to_thread(_status, got, fresh=True)
    if not status["behind"]:
        return {"updated": False, "code": "up-to-date", **status}
    newer = got.origin.model_copy(update={"head_commit": status["latest"]})
    try:
        with share_consent(apply):
            local_root, project_id = await get_origin_driver(newer.kind).receive(
                newer, preferred_root=got.root, preferred_project_id=getattr(got.row, "project_id", None)
            )
    except NeedsApply as e:
        return {"updated": False, "code": None, **e.answer(), **status}
    except GitShareError as e:
        return {"updated": False, "code": e.code, "message": str(e), **e.data, **status}
    asset_ref = await reopen_git_share(entity_type, entity_id, newer, local_root, project_id)
    return {
        "updated": True,
        "code": None,
        **status,
        "commit": status["latest"],
        "behind": 0,
        "asset_ref": str(asset_ref),
    }


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
    info, typeid = _target_typeid()
    if typeid is None:
        return _no_target()
    try:
        body = GitShareApply.model_validate(await info.get_post_data() or {})
    except ValidationError as e:
        return ApiFailResponse(message=f"Invalid git share update: {e}", status_code=400)
    return ApiSuccessResponse(data=await git_share_update(typeid.type, str(typeid.id), apply=body.apply))
