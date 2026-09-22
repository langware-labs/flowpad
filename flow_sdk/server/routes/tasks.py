"""The task ledger over HTTP — what ``flow task`` calls — and a channel-aware conversation reply.

Every request names its ``caller`` (the calling process's typeid, from the CLI's
``FLOWPAD_EXECUTION_SCOPE``); the backend decides what that process may act as
(:func:`flow_sdk.tasks.identity.caller_of`) — a subagent run acts only as its task's owner, an
agent's worker as the agent. The ledger then refuses whatever that principal may not do.

* ``POST /api/v1/tasks``                       create (the caller is the creator)
* ``GET  /api/v1/tasks``                       open tasks (``?mine=1``, ``?thread=current``, ``?all=1``)
* ``GET  /api/v1/tasks/<id>``                  one task and its log
* ``POST /api/v1/tasks/<id>/<event>``          start · note · ask · reply · done · fail · cancel
* ``POST /api/v1/tasks/<id>/keep``             promote a delegated task into its project (a ``task.md``, in git)
* ``POST /api/v1/conversations/<id>/reply``    say something to the person, on their channel
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1")

#: CLI verb → ledger event.
VERBS = {"start": "started", "note": "note", "ask": "asked", "reply": "replied", "done": "done", "fail": "failed", "cancel": "canceled"}


async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


@router.post("/tasks")
async def create_task(request: Request):
    from flow_sdk.tasks import ledger  # noqa: PLC0415
    from flow_sdk.tasks.identity import caller_of  # noqa: PLC0415

    body = await _body(request)
    caller = await caller_of(body.get("caller"))
    thread = str(body.get("thread") or "")
    origin_conversation = caller.conversation_id if thread in ("", "current") else thread
    origin_session = str(getattr(caller.process, "target_typeid_str", "") or "") if caller.process is not None else ""
    try:
        task = await ledger.create(
            title=str(body.get("title") or ""), brief=str(body.get("brief") or ""), creator=caller.principal,
            owner=str(body.get("owner") or ""), origin_conversation=origin_conversation,
            origin_session=origin_session if thread in ("", "current") else "",
            project_id=caller.project_id, budget_usd=body.get("budget_usd"), budget_turns=body.get("budget_turns"),
            parent_id=str(body.get("parent_id") or caller.owned_task_id or ""),
        )
    except ledger.TaskLedgerError as exc:
        return ApiFailResponse(message=str(exc))
    return ApiSuccessResponse(data=ledger.summary(task))


@router.get("/tasks")
async def list_tasks(request: Request, caller: str = "", mine: bool = False, thread: str = "", all: bool = False):  # noqa: A002
    from flow_sdk.tasks import ledger  # noqa: PLC0415
    from flow_sdk.tasks.identity import caller_of  # noqa: PLC0415

    who = await caller_of(caller)
    conversation = who.conversation_id if thread == "current" else thread
    rows = await ledger.open_tasks(principal=who.principal if (mine or not all) else "", origin_conversation=conversation)
    return ApiSuccessResponse(data={"principal": who.principal, "tasks": [ledger.summary(t) for t in rows]})


@router.get("/tasks/{task_id}")
async def show_task(task_id: str):
    from flow_sdk.builtin.task import Task  # noqa: PLC0415
    from flow_sdk.tasks import ledger  # noqa: PLC0415

    task = await Task.get_by_id(task_id)
    if task is None:
        return ApiFailResponse(message=f"no task {task_id}")
    log = [{"event": c.data.get("task_event"), "author": c.data.get("author"), "text": c.data.get("text"), "at": str(c.created_date or "")}
           for c in await ledger.comments(task)]
    return ApiSuccessResponse(data={**ledger.summary(task), "brief": await ledger.brief_of(task), "log": log})


@router.post("/tasks/{task_id}/keep")
async def keep_task(task_id: str, request: Request):
    """A person keeps a delegated task: it leaves the instance and becomes a project asset. A task
    run cannot keep its own task — what lands in git is the person's call."""
    from flow_sdk.tasks import ledger  # noqa: PLC0415
    from flow_sdk.tasks.identity import caller_of  # noqa: PLC0415

    caller = await caller_of((await _body(request)).get("caller"))
    if caller.owned_task_id:
        return ApiFailResponse(message="a task run cannot keep a task in the project")
    try:
        task = await ledger.keep(task_id)
    except ledger.TaskLedgerError as exc:
        return ApiFailResponse(message=str(exc))
    return ApiSuccessResponse(data={**ledger.summary(task), "asset_ref": task.asset_ref or ""})


@router.post("/tasks/{task_id}/{verb}")
async def task_event(task_id: str, verb: str, request: Request):
    from flow_sdk.tasks import ledger  # noqa: PLC0415
    from flow_sdk.tasks.identity import caller_of  # noqa: PLC0415

    event = VERBS.get(verb)
    if event is None:
        return ApiFailResponse(message=f"no task verb {verb!r} (one of {', '.join(VERBS)})")
    body = await _body(request)
    caller = await caller_of(body.get("caller"))
    if caller.owned_task_id and caller.owned_task_id != task_id:
        # Every run of one staff member shares its owner ref; the run is still bound to ITS task.
        return ApiFailResponse(message=f"this run owns task {caller.owned_task_id}, not {task_id}")
    try:
        task = await ledger.record(
            task_id, event, author=caller.principal, text=str(body.get("text") or ""),
            result=body.get("result"), artifacts=list(body.get("artifacts") or []) or None,
        )
    except ledger.TaskLedgerError as exc:
        return ApiFailResponse(message=str(exc))
    return ApiSuccessResponse(data=ledger.summary(task))


@router.post("/conversations/{conversation_id}/reply")
async def conversation_reply(conversation_id: str, request: Request):
    """Say ``text`` to the person in a conversation, through the channel it lives on — the one way a
    Chief of Staff speaks outside, whichever channel the person used."""
    from flow_sdk.stream_inbox.outbound import dispatch_channel_reply  # noqa: PLC0415

    body = await _body(request)
    text = str(body.get("text") or "").strip()
    if not text:
        return ApiFailResponse(message="nothing to say")
    return await dispatch_channel_reply(conversation_id, text=text)


__all__ = ["VERBS", "router"]
