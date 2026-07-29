"""``assign-task`` — give ONE task to ONE person.

Assignment is a SHARE, not a fan-out. The task itself goes to the hub and the
assignee is granted ``editor`` on it, so they simply have it — the hub grants an
internal invite's roles at invite time, so no Accept step stands between the ask
and their board (measured against the local hub, 2026-07-28).

There is exactly one row: the task. No child "member task", no ``kind=group``
flip, no ``sync-group`` poll. Those exist for the contacts-group fan-out
(``group_task_action``), where N members each need their own status — at N=1
there is one status and one other writer, so the whole construct collapses.

What keeps one shared row safe is ``TypeInfo.assignee_owned_fields``: the
assignee's hub-reflected write carries only ``status``/``completed_at``, so they
move the work along without rewriting the ask (see
``_hub_reflect.scope_body_to_assignee_fields``).

``group_task_action`` imports its request gate and hub helpers from here — the
group flow depends on the primitive, never the reverse.
"""

from __future__ import annotations

import logging
from json import JSONDecodeError
from typing import Iterable

from fastapi import HTTPException

from flow_sdk.actions import action
from flow_sdk.app.actions.share_action import (
    LOCAL_MODE_SHARE_MESSAGE,
    _local_mode_share_blocked,
)
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.user import normalize_email
from flow_sdk.cloud_client.transport.hub_http import hub_post, hub_put
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.flowpad_types.enums.auth_enums import HubRole
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.request_context.request_info import RequestInfo
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


def assignee_invite_body(email: str, task: Task, message: str | None = None) -> dict:
    """The ``MembershipRequest`` that hands ``task`` to ``email`` as its assignee.

    ONE target, ``editor`` on the task itself. The group flow's two-target form
    (editor-on-child + guest-on-parent) exists only because it has a child; a
    single-target internal invite auto-grants just the same.
    """
    return {
        "recipient_email": email,
        "invitation_targets": [{"typeid": f"task-{task.id}", "role": HubRole.EDITOR.value}],
        "message": message or f'You have been assigned the task "{task.title}"',
    }


async def ensure_task_on_hub(task: Task, someone_typeid) -> bool:
    """Blob-expand + first-share the task so hub writes can follow.

    Returns True when it shared the task on THIS call. That matters to callers:
    ``share()`` POSTs the entity's whole field body, so a caller that stamped
    fields beforehand needs neither a second save nor a field push — the hub row
    already has them. Sharing is once-only (``remote`` latches), so a re-assign
    returns False and the caller does both.

    ``description`` is a blob — expand it or the hub POST body carries an empty
    body.
    """
    try:
        await task.expand_blobs()
    except Exception as e:  # noqa: BLE001
        logger.warning("[task-assign] blob expansion failed (non-fatal): %s", e)
    if task.remote:
        return False
    await task.share()
    task.remote = True
    await task.save(someone_typeid)
    return True


async def push_hub_fields(task: Task, fields: Iterable[str]) -> None:
    """Push named fields to the task's hub row.

    A SERVER-side save never hub-reflects (that's the ``Hub-Reflect`` header the
    client sends), so a field an action writes locally would otherwise never
    reach the hub — the assignee would fetch a row with no ``assignee`` on it.
    Non-fatal: the local write already succeeded.
    """
    names = list(fields)
    if not names:
        return
    try:
        await hub_put(
            BuiltinEntityType.TASK,
            str(task.id),
            {name: getattr(task, name, None) for name in names},
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("[task-assign] hub field push %s failed (non-fatal): %s", names, e)


async def require_assignable_task(action_name: str) -> tuple[Task, RequestInfo, dict, str | None]:
    """Shared entry gate for the assignment actions.

    Enforces local-mode + cloud login and resolves the target task, returning
    everything both actions need from the request: ``(task, request_info, body,
    owner_email)`` — the owner email comes from the same credentials read as the
    login check rather than a second one.

    Note it does NOT reject a task that has a parent: a sub-task is just a task
    and can be handed to someone. Only the group fan-out cares, and it enforces
    that itself.
    """
    if _local_mode_share_blocked():
        raise HTTPException(status_code=403, detail=LOCAL_MODE_SHARE_MESSAGE)
    from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415

    creds = load_credentials()
    if not creds or not creds.api_key:
        raise HTTPException(status_code=403, detail=f"Cloud login required to {action_name}")

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        raise HTTPException(status_code=400, detail=f"{action_name}: target task typeid required")
    target = request_info.target_entity_typeid
    if target.type != Task.get_type():
        raise HTTPException(status_code=400, detail=f"{action_name}: target must be a task")

    task = await Task.get_one({"id": target.id})
    if task is None:
        raise HTTPException(status_code=404, detail=f"{action_name}: task not found")

    try:
        body = await request_info.get_post_data() or {}
    except JSONDecodeError:
        body = {}
    return task, request_info, body, normalize_email((creds.user or {}).get("email"))


@action.post(action_name="assign-task", types=["task"])
async def assign_task() -> ApiResponse:
    """``POST /graph/task/<id>/assign-task`` — give this task to ONE person.

    Body: ``{"email": ..., "name"?: ..., "message"?: ...}``.

    Stamps ``assignee``/``reporter``, puts the task on the hub, and grants the
    assignee ``editor`` on it. Their status changes reflect back automatically
    (the hub pushes the row to every role-holder), so there is nothing to sync
    and nothing to accept.

    Assigning to yourself is a local stamp only: no hub write, no invitation.
    """
    task, request_info, body, owner_email = await require_assignable_task("assign-task")

    email = normalize_email(body.get("email"))
    if not email:
        raise HTTPException(status_code=400, detail="assign-task: 'email' required")
    message = str(body.get("message") or "").strip() or None

    task.assignee = email
    task.reporter = task.reporter or owner_email

    if email == owner_email:
        await task.save(request_info.someone_typeid)
        return ApiSuccessResponse(data={"self": True, "assignee": email})

    # A first share POSTs the full field body (stamps included) and persists the
    # row, so only a RE-assign needs the extra save + field push — a server-side
    # save never hub-reflects.
    if not await ensure_task_on_hub(task, request_info.someone_typeid):
        await task.save(request_info.someone_typeid)
        await push_hub_fields(task, ("assignee", "reporter"))
    await hub_post(
        BuiltinEntityType.TASK,
        assignee_invite_body(email, task, message),
        task.id,
        "members",
    )
    return ApiSuccessResponse(data={"self": False, "assignee": email})
