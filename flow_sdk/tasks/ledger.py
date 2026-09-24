"""The task ledger — the ONE writer of a delegated task's lifecycle.

A delegated task is an ordinary ``Task`` row with a creator (who asked), an owner (who does it)
and the conversation it came from. Every change to it goes through :func:`record`, which does
three things together, so no reader ever sees one without the others:

1. the task row moves (status, result, cost …);
2. a **Comment** on the task says what happened, in words — the task's working log, and the
   messages of its thread on the Tasks channel (author and event in the comment's ``data``,
   because a comment's ``created_by`` never leaves this machine);
3. ``task.<event>`` goes on the bus (target ``task:<id>``) with the participants in it — what
   :mod:`delivery` and the Tasks channel listen to. Entity tags carry only ids, so this is the
   one announcement a task change has.

The events and what they do to the status (A2A's task states)::

    created   → submitted            asked     working → input_required
    started   → working              replied   → working (from input_required) — else unchanged
    note        (no change)          done / failed / canceled → terminal
    stalled     (no change; raised by the watchdog)
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.task_spec import TERMINAL_STATUSES, TaskStatus

logger = logging.getLogger(__name__)


class TaskEvent(StrEnum):
    CREATED = "created"
    STARTED = "started"
    NOTE = "note"
    ASKED = "asked"
    REPLIED = "replied"
    DONE = "done"
    FAILED = "failed"
    CANCELED = "canceled"
    STALLED = "stalled"


#: event → the status it leaves the task in (``None`` = unchanged).
_TO: dict[TaskEvent, Optional[TaskStatus]] = {
    TaskEvent.CREATED: TaskStatus.SUBMITTED,
    TaskEvent.STARTED: TaskStatus.WORKING,
    TaskEvent.NOTE: None,
    TaskEvent.ASKED: TaskStatus.INPUT_REQUIRED,
    TaskEvent.REPLIED: None,  # input_required → working, handled in record()
    TaskEvent.DONE: TaskStatus.DONE,
    TaskEvent.FAILED: TaskStatus.FAILED,
    TaskEvent.CANCELED: TaskStatus.CANCELED,
    TaskEvent.STALLED: None,
}
#: event → who may raise it: the task's ``creator``, its ``owner``, or the ``system``.
_BY: dict[TaskEvent, frozenset[str]] = {
    TaskEvent.CREATED: frozenset({"creator"}),
    TaskEvent.STARTED: frozenset({"owner", "system"}),
    TaskEvent.NOTE: frozenset({"owner", "creator"}),
    TaskEvent.ASKED: frozenset({"owner"}),
    TaskEvent.REPLIED: frozenset({"creator", "owner"}),
    TaskEvent.DONE: frozenset({"owner"}),
    TaskEvent.FAILED: frozenset({"owner", "system"}),
    TaskEvent.CANCELED: frozenset({"creator", "system"}),
    TaskEvent.STALLED: frozenset({"system"}),
}
SYSTEM = "system"


class TaskLedgerError(ValueError):
    """A change the ledger refuses: a terminal task, a stranger, an event out of turn."""


def role_of(task, author: str) -> str:
    if author == SYSTEM:
        return "system"
    if author and author == (task.owner or ""):
        return "owner"
    if author and author == (task.creator or ""):
        return "creator"
    return ""


async def create(
    *,
    title: str,
    brief: str,
    creator: str,
    owner: str,
    origin_conversation: str = "",
    origin_session: str = "",
    project_id: Optional[str] = None,
    budget_usd: Optional[float] = None,
    budget_turns: Optional[int] = None,
    parent_id: str = "",
):
    """A new delegated task, ``submitted`` — its brief is the task's description (the contract)."""
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
    from flow_sdk.builtin.task import Task  # noqa: PLC0415

    if not (title or "").strip() or not (brief or "").strip():
        raise TaskLedgerError("a task needs a title and a brief")
    if not creator or not owner:
        raise TaskLedgerError("a task needs a creator and an owner")
    if parent_id:
        parent = await Task.get_by_id(parent_id)
        if parent is not None and getattr(parent, "remote", False):
            # A child of a hub-shared task is auto-shared with it — a delegated task never leaves the machine.
            raise TaskLedgerError("a delegated task cannot hang under a shared task")
    task = Task.model_validate({
        "id": mint_uuid(),
        "title": title.strip(),
        "description": brief.strip(),
        "status": TaskStatus.SUBMITTED.value,
        "creator": creator,
        "owner": owner,
        "origin_conversation": origin_conversation or None,
        "origin_session": origin_session or (f"conversation-{origin_conversation}" if origin_conversation else None),
        "budget_usd": budget_usd,
        "budget_turns": budget_turns,
        "parent_id": parent_id or "",
        # Agent bookkeeping, not a person's work item: the row stays on this machine, out of the repo.
        "placement": "instance",
        **({"project_id": project_id} if project_id else {}),
    })
    task = await task.save()
    note = await _log(task, TaskEvent.CREATED, creator, brief.strip())
    _announce(task, TaskEvent.CREATED, creator, text=brief.strip(), comment_id=note.id)
    return task


async def record(
    task_or_id: Any,
    event: TaskEvent | str,
    *,
    author: str,
    text: str = "",
    result: Optional[str] = None,
    artifacts: Optional[list] = None,
    run: Optional[str] = None,
    cost_usd: Optional[float] = None,
):
    """One lifecycle event on a task, by ``author`` (a typed ref, or ``system``). Returns the task."""

    event = TaskEvent(event)
    task = await _fresh(task_or_id)
    if task is None:
        raise TaskLedgerError(f"no task {task_or_id}")
    if event is TaskEvent.CREATED:
        raise TaskLedgerError("a task is created with ledger.create")
    role = role_of(task, author)
    if role not in _BY[event]:
        raise TaskLedgerError(f"{author or 'nobody'} may not mark task {task.id} {event.value} (only its {', '.join(sorted(_BY[event]))})")
    status = TaskStatus(task.status) if task.status in TaskStatus.__members__.values() else TaskStatus.TO_DO
    if status in TERMINAL_STATUSES:
        raise TaskLedgerError(f"task {task.id} is {status.value}; nothing more happens to it")
    if event is TaskEvent.ASKED and status is not TaskStatus.WORKING:
        raise TaskLedgerError(f"only a working task can ask (task {task.id} is {status.value})")

    target = _TO[event]
    if event is TaskEvent.REPLIED and status is TaskStatus.INPUT_REQUIRED:
        target = TaskStatus.WORKING
    if target is not None:
        task.status = target.value
    if target in TERMINAL_STATUSES:
        task.completed_at = datetime.now(timezone.utc)
    if result is not None:
        task.result = result
    if artifacts:
        task.artifacts = [*(task.artifacts or []), *artifacts]
    if run:
        task.process_id = run
    if cost_usd is not None:
        task.cost_usd = cost_usd
    task = await task.save()
    words = text or result or ""
    note = await _log(task, event, author, words)
    _announce(task, event, author, text=words, comment_id=note.id)
    return task


async def keep(task_or_id, *, scope_root: Optional[str] = None):
    """Promote a delegated task into the project: it becomes a ``task.md`` folder asset, in git.
    The person decides — nothing is promoted on its own."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    task = await _fresh(task_or_id)
    if task is None:
        raise TaskLedgerError(f"no task {task_or_id}")
    if task.placement != "instance":
        return task
    root = scope_root
    if root is None and task.project_id:
        project = await Project.get_by_id(task.project_id)
        root = getattr(project, "fs_storage_mount_path", None)
    if not root:
        raise TaskLedgerError(f"task {task.id} has no project to keep it in")
    task.placement = "repo"
    from pathlib import Path  # noqa: PLC0415

    await task._prepare_for_storage(scope_root=Path(root))  # noqa: SLF001 — the placement seam, as installs use it
    return await task.save()


async def brief_of(task) -> str:
    """The task's brief (its description). A blob, so a row fetched by a query does not carry it
    until it is expanded."""
    if not task.description:
        await task.expand_blobs()
    return task.description or ""


async def attach_run(task, run: str):
    """Stamp the process that works a task on it — bookkeeping, not a lifecycle event."""
    task = await _fresh(task)
    task.process_id = run
    return await task.save()


async def _fresh(task_or_id):
    """The task as stored NOW. Every write starts here: a caller's copy may be seconds old (a
    dispatcher builds a run between reading the task and stamping it), and saving it whole would
    put back a status its owner has since moved."""
    from flow_sdk.builtin.task import Task  # noqa: PLC0415

    task_id = str(getattr(task_or_id, "id", task_or_id) or "")
    return await Task.get_by_id(task_id) if task_id else None


async def open_tasks(*, principal: str = "", origin_conversation: str = "") -> list:
    """Tasks not yet terminal where ``principal`` is creator or owner, and/or from one conversation."""
    from flow_sdk.builtin.task import Task  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    delegated = QueryFilter(match=ExpressionNode(op=QueryOp.IS_NOT_NULL, operands=["owner"]))
    rows = await Task.get_all(delegated)
    out = []
    for task in rows or []:
        if not task.owner or task.status in {s.value for s in TERMINAL_STATUSES}:
            continue
        if principal and principal not in (task.owner, task.creator):
            continue
        if origin_conversation and task.origin_conversation != origin_conversation:
            continue
        out.append(task)
    return sorted(out, key=lambda t: str(t.created_date or ""))


async def comments(task) -> list:
    """The task's working log, oldest first."""
    from flow_sdk.builtin.comment import Comment  # noqa: PLC0415

    rows = await Comment.get_all({"parent_type_id": str(task.typeid)})
    return sorted(rows or [], key=lambda c: str(c.created_date or ""))


def summary(task) -> dict:
    """The task as the CLI and the prompts show it."""
    return {
        "id": task.id, "title": task.title, "status": task.status, "creator": task.creator, "owner": task.owner,
        "origin_conversation": task.origin_conversation, "origin_session": task.origin_session, "result": task.result,
        "run": task.process_id, "placement": task.placement,
        "cost_usd": task.cost_usd, "artifacts": list(task.artifacts or []),
    }


def render_event(data: dict) -> str:
    """A task event as the message a participant receives — one shape for creator and owner alike::

        [task <id> · <event> · by <author>] <title>
        <text>
    """
    head = f"[task {data.get('task_id')} · {data.get('event')} · by {data.get('author')}] {data.get('title') or ''}".rstrip()
    body = str(data.get("text") or "").strip()
    return f"{head}\n{body}" if body else head


# ── internals ────────────────────────────────────────────────────────────────


async def _log(task, event: TaskEvent, author: str, text: str):
    from flow_sdk.builtin.comment import Comment  # noqa: PLC0415

    body = text or f"{event.value}"
    return await Comment(
        raw_content=body,
        parent_type_id=str(task.typeid),
        # The words also ride ``data``: ``raw_content`` is a blob a list query does not load.
        data={"task_event": event.value, "author": author, "status": task.status, "text": body},
    ).save(task.typeid)


def _announce(task, event: TaskEvent, author: str, *, text: str, comment_id: str) -> None:
    from flow_sdk.tags import emit_tag, target_of  # noqa: PLC0415

    emit_tag(
        f"task.{event.value}",
        target_of("task", task.id),
        {
            "task_id": task.id, "event": event.value, "author": author, "text": text[:4000], "comment_id": comment_id,
            "status": task.status, "creator": task.creator, "owner": task.owner,
            "origin_conversation": task.origin_conversation, "origin_session": task.origin_session, "title": task.title,
        },
    )


__all__ = ["SYSTEM", "TaskEvent", "TaskLedgerError", "attach_run", "comments", "keep", "create", "open_tasks", "record", "render_event", "role_of", "summary"]
