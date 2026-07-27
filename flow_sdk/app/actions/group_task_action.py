"""Task assignment actions: ``create-group-task`` + ``assign-task`` + ``sync-group``.

A GROUP task is one task instantiated for every member of a contacts group:
the original task becomes the overview (``kind=group``) and each member gets
their own child "member task" (``parent_id`` = the group task, ``assignee`` =
the member). Only the title is cloned; a member task owns nothing but its
``status`` / ``completed_at`` — every display field resolves from the parent at
render time. The member's deliverable is not a field: they record it as a
standard ``Comment`` on their member task, which auto-shares to the hub and is
pulled onto the owner's mirror during ``sync-group`` (see
``_sync_group_owner``).

Transport is the hub + membership invitations (NOT the git/push-notify
shared-task channel): children are created on the hub as real ``is_child``
children of the parent (owner rights cascade through the edge), and each
member receives ONE invitation carrying two targets — ``editor`` on their own
member task and ``guest`` on the parent. The hub marks the guest grant
``is_final`` at accept (see hub ``membership/services.py``) so it stops at the
parent and never cascades to sibling member tasks.

``assign-task`` is the single-owner form of the same fan-out (a group of one):
one member task, one invitation, and — because the hub grants an internal
invite's roles at invite time — the assignee simply has the task, JIRA-style.
It shares every helper below with the group flow.

Pull remains the fallback for freshness:
``sync-group`` is fired by the UI when a group row is expanded/opened (owner
side pulls member-owned fields; member side pulls the parent's display
fields). The parent's plan (``spec.md``) is deliberately NOT shared — task and
spec are decoupled; the plan never leaves the owner's machine.
"""

from __future__ import annotations

import logging
from datetime import datetime
from json import JSONDecodeError
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

from flow_sdk._compat import UTC
from flow_sdk.actions import action
from flow_sdk.app.actions.share_action import (
    LOCAL_MODE_SHARE_MESSAGE,
    _local_mode_share_blocked,
)
from flow_sdk.builtin.contacts_group import ContactsGroup
from flow_sdk.builtin.task import Task, TaskKind, TaskStatus
from flow_sdk.builtin.user import normalize_email
from flow_sdk.cloud_client.transport.hub_http import hub_get, hub_post, hub_put
from flow_sdk.core.entity.entity_model import remote_reflection
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.request_context.request_info import RequestInfo
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

# The ONLY fields a member owns; the owner-side sync merges exactly these from
# each member task's hub row. The member's deliverable is no longer a field —
# it rides as a ``Comment`` on the member task (pulled separately below).
_MEMBER_OWNED_FIELDS = ("status",)
# Display fields the member-side sync merges onto the local parent mirror
# (single source of truth: children never store their own copies).
_PARENT_DISPLAY_FIELDS = ("title", "description", "priority")
_PARENT_DISPLAY_DATETIMES = ("due_at", "start_date")
# Owner-authored collection fields pulled onto the parent mirror too, so the
# member's read-only "Files & Folders" shows the owner's attachments (each entry
# carries a ``git_origin`` reference for context/git folders). List-valued, so
# merged separately from the string display fields below.
_PARENT_DISPLAY_COLLECTIONS = ("artifacts",)


def _safe_task_folder_name(title: str | None) -> str:
    """Folder-safe slug of a task title — mirrors ``FSRecord._safe_name``."""
    raw = (title or "").strip().lower()
    out = "".join(c if (c.isalnum() or c in "_-") else "_" for c in raw)
    return out or "untitled"


def _member_asset_ref(parent_asset_ref: str | None, title: str | None, child_id: str | None) -> str | None:
    """Deduped folder for a member task: ``tasks/<safe_title>--m-<id8>/``.

    Every member task clones the parent title, and the default asset_ref is
    derived from the title — an un-suffixed child would claim the PARENT's
    folder, and ``owns_main_ref`` would then rewrite the parent's ``task.md``.
    Must be pre-set before the child's first save on BOTH sides (owner create
    and member materialize); ``Entity._prepare_for_storage`` honors it.
    """
    if not parent_asset_ref or not child_id:
        return None
    base = Path(str(parent_asset_ref).rstrip("/"))
    return canonical_posix_path(base.parent / f"{_safe_task_folder_name(title)}--m-{child_id[:8]}")


async def materialize_remote_task(
    data: dict[str, Any],
    someone_typeid,
    *,
    parent_ref: str | None = None,
    notify: bool = True,
) -> Optional[Task]:
    """Upsert a hub task dict as a local ``remote=True`` Task row.

    ``parent_ref`` (the local parent mirror's asset_ref) triggers the deduped
    member-folder pre-set when the payload carries ``parent_id``. Existing rows
    are refreshed LWW (``is_stale``) on the hub-owned fields only — never the
    locally-authoritative asset path.
    """
    if not isinstance(data, dict):
        return None
    ent_id = str(data.get("id") or "").strip()
    if not ent_id:
        return None

    sanitized = {k: v for k, v in data.items() if Task.is_api_field(k)}
    sanitized.pop("asset_ref", None)  # hub paths never bind local storage
    sanitized["id"] = ent_id

    existing = await Task.get_one({"id": ent_id})
    if existing is None:
        ent = Task.model_validate(sanitized)
        ent.remote = True
        if data.get("parent_id"):
            ref = _member_asset_ref(parent_ref, ent.title, ent_id)
            if ref:
                ent.asset_ref = ref
        with remote_reflection():
            ent = await ent.save(someone_typeid, notify=notify)
        return ent

    if not Task.is_stale(existing, data):
        return existing
    changed = False
    for k, v in sanitized.items():
        if k in ("id", "asset_ref") or v is None:
            continue
        if getattr(existing, k, None) != v:
            setattr(existing, k, v)
            changed = True
    if not existing.remote:
        existing.remote = True
        changed = True
    if changed:
        existing.fetched_at = datetime.now(UTC)
        with remote_reflection():
            existing = await existing.save(someone_typeid, notify=notify)
    return existing


async def materialize_accepted_task_invitation(target_id: str, someone_typeid) -> Optional[Task]:
    """Accept-side materialization for a member-task invitation.

    The invitation carries TWO task targets (member task + group parent) and
    the hub resolves an arbitrary one as the inbox target — so handle both:

    - handed the CHILD (has ``parent_id``): pull + materialize the parent
      first (its asset_ref anchors the child's deduped folder), then the child;
    - handed the PARENT: materialize it, then pull its hub children — the
      listing is access-filtered, so a member only ever receives their own
      member task — and materialize those.

    Called from ``handle_invitation_accept``.
    """
    hub_task = await hub_get(BuiltinEntityType.TASK, target_id, params={"expand": "blobs"})
    if not isinstance(hub_task, dict) or not hub_task.get("id"):
        return None

    parent_id = hub_task.get("parent_id")
    if parent_id:
        parent: Optional[Task] = None
        hub_parent = await hub_get(BuiltinEntityType.TASK, str(parent_id), params={"expand": "blobs"})
        if isinstance(hub_parent, dict) and hub_parent.get("id"):
            parent = await materialize_remote_task(hub_parent, someone_typeid)
        child = await materialize_remote_task(
            hub_task, someone_typeid, parent_ref=(parent.asset_ref if parent else None)
        )
        if parent is not None:
            await _notify_quietly(parent)
        return child

    parent = await materialize_remote_task(hub_task, someone_typeid)
    if parent is None:
        return None
    children = await hub_get(BuiltinEntityType.TASK, target_id, action=Task.get_type(), params={"expand": "blobs"})
    child_list = children if isinstance(children, list) else []
    child: Optional[Task] = None
    for raw in child_list:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        materialized = await materialize_remote_task(raw, someone_typeid, parent_ref=parent.asset_ref)
        child = child or materialized
    await _notify_quietly(parent)
    return child or parent


async def _notify_quietly(entity: Task) -> None:
    try:
        await entity.notify_updated()
    except Exception as e:  # noqa: BLE001
        logger.warning("[group-task] notify failed (non-fatal): %s", e)


def _group_members(group: ContactsGroup, owner_email: str | None) -> tuple[list[str], list[dict]]:
    """Normalized, deduped member emails minus the owner; email-less entries
    are reported as failures (invitations are email-keyed)."""
    members: list[str] = []
    failed: list[dict] = []
    seen: set[str] = set()
    for entry in group.contacts or []:
        if not isinstance(entry, dict):
            continue
        email = normalize_email(entry.get("email"))
        if not email:
            label = entry.get("name") or entry.get("user_id") or "<unnamed contact>"
            failed.append({"email": None, "error": f"contact '{label}' has no email"})
            continue
        if email == owner_email or email in seen:
            continue
        seen.add(email)
        members.append(email)
    return members, failed


async def _resolve_group(body: dict) -> ContactsGroup:
    """Resolve the contacts group from the action body: an explicit
    ``members`` list (frontend-computed group — membership is never stored,
    so the client sends the participant dicts directly; wins over group_id)
    or a stored group by ``group_id``. The computed branch builds a transient
    group only ``_group_members`` will read — never saved."""
    raw_members = body.get("members")
    if isinstance(raw_members, list):
        return ContactsGroup(contacts=[m for m in raw_members if isinstance(m, dict)])
    group_id = str(body.get("group_id") or "").strip()
    if not group_id:
        raise HTTPException(status_code=400, detail="create-group-task: 'group_id' or 'members' required")
    group = await ContactsGroup.get_one({"id": group_id})
    if group is None:
        raise HTTPException(status_code=404, detail="create-group-task: contacts group not found")
    return group


async def _invite_member(email: str, child: Task, parent: Task, message: str | None = None) -> None:
    """One invitation, two targets — the member task FIRST (the hub renders the
    first non-conversation target as the inbox row), then the parent as guest.

    ``message`` rides the invitation email; the default states the assignment.
    """
    body = {
        "recipient_email": email,
        "invitation_targets": [
            {"typeid": f"task-{child.id}", "role": "editor"},
            {"typeid": f"task-{parent.id}", "role": "guest"},
        ],
        "message": message or f'You have been assigned the task "{parent.title}"',
    }
    await hub_post(BuiltinEntityType.TASK, body, child.id, "members")


async def _prepare_parent_for_hub(task: Task, someone_typeid) -> None:
    """Blob-expand + first-share the parent so member fan-out can hub-write."""
    # Description is a blob — expand so it rides the hub POST body.
    try:
        await task.expand_blobs()
    except Exception as e:  # noqa: BLE001
        logger.warning("[group-task] blob expansion failed (non-fatal): %s", e)
    if not task.remote:
        await task.share()
        task.remote = True
        await task.save(someone_typeid)


async def _existing_children_by_assignee(task: Task) -> dict[str, Task]:
    """Member tasks of ``task`` keyed by normalized assignee — the dedupe key
    that makes a re-run (re-invite, retry) converge instead of duplicating."""
    children = await Task.get_all({"parent_id": task.id}) or []
    return {normalize_email(c.assignee): c for c in children if normalize_email(c.assignee)}


async def _fan_out_member(
    task: Task,
    email: str,
    child: Optional[Task],
    someone_typeid,
    *,
    invite_message: str | None = None,
) -> tuple[Task, bool]:
    """Create-or-reuse ``email``'s member task and (re-)invite them.

    ``child`` is their existing member task, or None to mint one. Returns
    ``(child, created)``. The invitation is re-sent even for a pre-existing
    child so a previously failed one can be retried; an already-accepted invite
    is a hub 400 we treat as converged.
    """
    created = False
    if child is None:
        child = Task.model_validate(
            {
                "id": mint_uuid(),  # random v4 — member tasks have no natural key
                "title": task.title,  # ONLY the title is cloned
                "parent_id": task.id,
                "assignee": email,
                "kind": TaskKind.STANDARD,
                "status": TaskStatus.TO_DO,
                "project_id": task.project_id,
            }
        )
        ref = _member_asset_ref(task.asset_ref, task.title, child.id)
        if ref:
            child.asset_ref = ref
        child = await child.save(someone_typeid)
        # Real hub child (is_child edge) — owner rights cascade; the member's
        # guest-on-parent is cut at the parent by the hub's is_final grant, so
        # siblings never leak.
        await task.create_child(child)
        await child.save(someone_typeid)
        created = True
    try:
        await _invite_member(email, child, task, message=invite_message)
    except Exception as invite_err:  # noqa: BLE001
        if "accept" not in str(invite_err).lower():
            raise
    return child, created


def _apply_group_flip(task: Task, group_name: str | None) -> bool:
    """Mark the parent as a group overview in memory. Returns whether it changed
    — the caller owns the single save, so a flip can ride along with other
    parent-side edits instead of costing a second write."""
    if task.kind == TaskKind.GROUP.value and task.group_name == group_name:
        return False
    task.kind = TaskKind.GROUP.value
    # The group's name is what the owner surface renders ("Owner: <name>") —
    # the task itself is the only place it's persisted.
    task.group_name = group_name
    return True


async def _push_group_flip(task: Task) -> None:
    """Push the group flip to the hub. A server-side save doesn't hub-reflect
    (that's the client header path), so the hub row would otherwise never read
    ``group`` for a member fetch."""
    try:
        await hub_put(
            BuiltinEntityType.TASK,
            str(task.id),
            {"kind": task.kind, "group_name": task.group_name},
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("[group-task] hub kind flip failed (non-fatal): %s", e)


async def _require_assignable_task(action: str) -> tuple[Task, RequestInfo, dict, str | None]:
    """Shared entry gate for the assignment actions.

    Enforces local-mode + cloud login and resolves a top-level target task,
    returning everything both actions need from the request: ``(task,
    request_info, body, owner_email)`` — the owner email comes from the same
    credentials read as the login check rather than a second one.
    """
    if _local_mode_share_blocked():
        raise HTTPException(status_code=403, detail=LOCAL_MODE_SHARE_MESSAGE)
    from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415

    creds = load_credentials()
    if not creds or not creds.api_key:
        raise HTTPException(status_code=403, detail=f"Cloud login required to {action}")

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        raise HTTPException(status_code=400, detail=f"{action}: target task typeid required")
    target = request_info.target_entity_typeid
    if target.type != Task.get_type():
        raise HTTPException(status_code=400, detail=f"{action}: target must be a task")

    task = await Task.get_one({"id": target.id})
    if task is None:
        raise HTTPException(status_code=404, detail=f"{action}: task not found")
    if task.parent_id:
        raise HTTPException(status_code=400, detail=f"{action}: a member task cannot be re-assigned")

    try:
        body = await request_info.get_post_data() or {}
    except JSONDecodeError:
        body = {}
    return task, request_info, body, normalize_email((creds.user or {}).get("email"))


@action.post(action_name="create-group-task", types=["task"])
async def create_group_task() -> ApiResponse:
    """``POST /graph/task/<id>/create-group-task`` — body carries EITHER
    ``{"group_id": ...}`` (a stored contacts group) OR
    ``{"members": [{user_id?, email?, name?}]}`` (a frontend-computed group
    whose roster is never stored; ``members`` wins if both are present).

    Flips the target task into a group task and creates one member task per
    contacts-group member: local child row (title clone only) → hub child
    (``create_child``, is_child edge) → invitation (editor on child + guest on
    parent). Idempotent per member — re-running completes the remainder.
    """
    task, request_info, body, owner_email = await _require_assignable_task("create-group-task")
    group = await _resolve_group(body)

    members, failed = _group_members(group, owner_email)
    if not members and not failed:
        raise HTTPException(status_code=400, detail="create-group-task: the contacts group has no members")

    await _prepare_parent_for_hub(task, request_info.someone_typeid)
    by_assignee = await _existing_children_by_assignee(task)

    created: list[str] = []
    skipped: list[str] = []
    # Member-task typeids only — deliberately NO emails in the response (PII
    # stays out of action payloads); the dialog matches recipient → child via
    # the locally-stored ``assignee`` field on each task row.
    children: list[str] = []
    for email in members:
        try:
            child, was_created = await _fan_out_member(
                task, email, by_assignee.get(email), request_info.someone_typeid
            )
            (created if was_created else skipped).append(email)
            children.append(str(child.typeid))
        except Exception as e:  # noqa: BLE001
            logger.warning("[group-task] member %s failed: %s", email, e)
            failed.append({"email": email, "error": str(e)[:200]})

    # Only flip once a member task actually exists — an all-failed run leaves the
    # task as it was rather than advertising a group with no members.
    if (created or by_assignee) and _apply_group_flip(task, group.name):
        await task.save(request_info.someone_typeid)
        await _push_group_flip(task)

    return ApiSuccessResponse(data={"created": created, "skipped": skipped, "failed": failed, "children": children})


@action.post(action_name="assign-task", types=["task"])
async def assign_task() -> ApiResponse:
    """``POST /graph/task/<id>/assign-task`` — give this task to ONE person.

    Body: ``{"email": ..., "name"?: ..., "message"?: ...}``. The group-of-one
    form of ``create-group-task``: the assignee gets a real hub member task
    (``is_child``, editor-on-child + guest-on-parent) so their status changes
    sync back, and — for an invite between people who already share a container
    — the hub grants those roles immediately, so the task lands on their machine
    without an accept step. ``message`` rides the invitation email.

    Assigning to yourself is a local stamp only: no hub child, no invitation.
    """
    task, request_info, body, owner_email = await _require_assignable_task("assign-task")

    email = normalize_email(body.get("email"))
    if not email:
        raise HTTPException(status_code=400, detail="assign-task: 'email' required")
    name = str(body.get("name") or "").strip() or None
    message = str(body.get("message") or "").strip() or None

    task.assignee = email
    task.reporter = task.reporter or owner_email

    if email == owner_email:
        await task.save(request_info.someone_typeid)
        return ApiSuccessResponse(data={"child": None, "self": True, "created": False, "assignee": email})

    await _prepare_parent_for_hub(task, request_info.someone_typeid)
    by_assignee = await _existing_children_by_assignee(task)
    child, created = await _fan_out_member(
        task, email, by_assignee.get(email), request_info.someone_typeid, invite_message=message
    )

    # Reuse the group overview shape for a single owner: the member task carries
    # the status, the parent stays the display surface. Named after the person
    # so the owner surface reads "Owner: <name>". One save covers the flip and
    # the assignee/reporter stamp above.
    flipped = _apply_group_flip(task, name or email)
    await task.save(request_info.someone_typeid)
    if flipped:
        await _push_group_flip(task)

    return ApiSuccessResponse(data={"child": str(child.typeid), "self": False, "created": created, "assignee": email})


@action.post(action_name="sync-group", types=["task"])
async def sync_group() -> ApiResponse:
    """``POST /graph/task/<id>/sync-group`` — pull-based group freshness.

    Owner side (``kind=group``): merge each member task's member-owned fields
    from its hub row (LWW). Member side (``parent_id`` set): merge the parent's
    display fields onto the local parent mirror. Quiet no-op when logged out or
    the hub is unreachable — the UI fires this opportunistically.
    """
    from flow_sdk.cli.auth.hub_login import is_logged_in  # noqa: PLC0415

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        raise HTTPException(status_code=400, detail="sync-group: target task typeid required")
    target = request_info.target_entity_typeid
    if target.type != Task.get_type():
        raise HTTPException(status_code=400, detail="sync-group: target must be a task")

    task = await Task.get_one({"id": target.id})
    if task is None:
        raise HTTPException(status_code=404, detail="sync-group: task not found")
    if not is_logged_in():
        return ApiSuccessResponse(data={"synced": 0, "reason": "not logged in"})

    synced = 0
    try:
        if task.kind == TaskKind.GROUP.value:
            synced = await _sync_group_owner(task, request_info.someone_typeid)
        elif task.parent_id:
            synced = await _sync_group_member(task, request_info.someone_typeid)
    except Exception as e:  # noqa: BLE001
        logger.warning("[group-task] sync-group %s failed (non-fatal): %s", target.id, e)
        return ApiSuccessResponse(data={"synced": synced, "reason": str(e)[:200]})
    return ApiSuccessResponse(data={"synced": synced})


async def _sync_group_owner(task: Task, someone_typeid) -> int:
    """Merge member-owned fields from each member task's hub row (LWW), and pull
    each member task's comments (the member's "done + submission url" note)."""
    # Lazy import: flow_message_action imports this module's helpers, so a
    # top-level import would be circular.
    from flow_sdk.app.actions.flow_message_action import _sync_remote_children  # noqa: PLC0415

    children = await Task.get_all({"parent_id": task.id}) or []
    synced = 0
    for child in children:
        if not child.remote or not child.id:
            continue
        # Pull the child's comments FIRST, independent of the task-row LWW
        # below: a new comment (the member's submission note) is an is_child of
        # the member task on the hub and does NOT bump the task's own
        # updated_date, so the ``is_stale`` gate would otherwise skip it. The
        # owner is authorized on the child, so this reflects the comment into
        # the local DB for the group analyzer to read.
        try:
            await _sync_remote_children(child.typeid, BuiltinEntityType.COMMENT.value, someone_typeid)
        except Exception as e:  # noqa: BLE001
            logger.warning("[group-task] comment pull for %s failed (non-fatal): %s", child.id, e)
        hub_row = await hub_get(BuiltinEntityType.TASK, child.id)
        if not isinstance(hub_row, dict) or not hub_row.get("id"):
            continue
        if not Task.is_stale(child, hub_row):
            continue
        changed = False
        for k in _MEMBER_OWNED_FIELDS:
            v = hub_row.get(k)
            if isinstance(v, str) and v and getattr(child, k, None) != v:
                setattr(child, k, v)
                changed = True
        # Hub is authoritative here (is_stale passed): completed_at follows the
        # member's row even back to None (member un-done).
        completed = Task._as_datetime(hub_row.get("completed_at"))
        if completed != getattr(child, "completed_at", None):
            child.completed_at = completed
            changed = True
        if not changed:
            continue
        # Carry the hub LWW clock so the local save doesn't run ahead of it.
        hub_updated = Task._as_datetime(hub_row.get("updated_date"))
        if hub_updated is not None:
            child.updated_date = hub_updated
        child.fetched_at = datetime.now(UTC)
        with remote_reflection():
            await child.save(someone_typeid, notify=True)
        synced += 1
    return synced


async def _sync_group_member(child: Task, someone_typeid) -> int:
    """Merge the group parent's display fields onto the local parent mirror.

    The member's own child fields are locally authoritative — never touched.
    No plan/spec pull: the plan is deliberately not shared.
    """
    hub_parent = await hub_get(BuiltinEntityType.TASK, child.parent_id, params={"expand": "blobs"})
    if not isinstance(hub_parent, dict) or not hub_parent.get("id"):
        return 0
    parent = await Task.get_one({"id": child.parent_id})
    if parent is None:
        parent = await materialize_remote_task(hub_parent, someone_typeid)
        return 1 if parent is not None else 0
    if not Task.is_stale(parent, hub_parent):
        return 0
    changed = False
    for k in _PARENT_DISPLAY_FIELDS:
        v = hub_parent.get(k)
        if isinstance(v, str) and v and getattr(parent, k, None) != v:
            setattr(parent, k, v)
            changed = True
    for k in _PARENT_DISPLAY_DATETIMES:
        v = Task._as_datetime(hub_parent.get(k))
        if v is not None and v != getattr(parent, k, None):
            setattr(parent, k, v)
            changed = True
    for k in _PARENT_DISPLAY_COLLECTIONS:
        # The hub owns the attachment list; reflect it verbatim (including an
        # empty list, so a member sees the owner's removals). Absent key (older
        # hub / never set) → leave the local value untouched.
        v = hub_parent.get(k)
        if isinstance(v, list) and v != getattr(parent, k, None):
            setattr(parent, k, v)
            changed = True
    if not changed:
        return 0
    hub_updated = Task._as_datetime(hub_parent.get("updated_date"))
    if hub_updated is not None:
        parent.updated_date = hub_updated
    parent.fetched_at = datetime.now(UTC)
    with remote_reflection():
        await parent.save(someone_typeid, notify=True)
    return 1
