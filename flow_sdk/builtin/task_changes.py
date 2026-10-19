"""A task's history: each LOCAL change of its status, assignee or title becomes one comment on the task.

The task row keeps no history and its writer stamp (``updated_by``) never leaves this machine, so
"who moved it, and when" has nowhere to live but a record of its own. A comment is that record: it
rides the task's sharing like any other comment (a shared task's comment is a hub child both people
receive), it shows on the task, and the Tasks channel reads it as one message, credited to its author.

Written only for a change made HERE: a hub echo of the other person's change (a ``remote_reflection``
save) is skipped — their machine wrote its own comment, which arrives as a hub child. A delegated task
(``owner`` set) is skipped too — the task ledger already logs every move as a comment. So is the disk
re-index (a ``suppress_store`` save) and the task's creation.

``data`` shape::

    {"change": "status" | "assignee" | "title", "from": <old>, "to": <new>, "author": <email>, "text": <sentence>}
"""
from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: The fields whose changes are history.
TRACKED = ("status", "assignee", "title")


async def before(task: Any) -> Optional[dict]:
    """The stored values of the tracked fields when this save may change them; ``None`` when it is not
    a local change worth recording (a create, a hub echo, a disk re-index, a delegated task)."""
    from flow_sdk.core.entity.entity_model import in_remote_reflection, store_suppressed  # noqa: PLC0415

    if not task.id or in_remote_reflection() or store_suppressed() or task.owner:
        return None
    # Looked up, not read off ``exist_in_db``: that flag is "has a creator stamp", and a task received from
    # the hub is stored with none — every change the assignee made would have read as a create.
    stored = await type(task).get_one({"id": task.id})
    if stored is None:
        return None  # a create: the task itself is its first message
    return {field: getattr(stored, field, None) for field in TRACKED}


async def record(task: Any, prior: dict) -> list:
    """One comment per tracked field this save changed. Never fails the save that triggered it."""
    written = []
    for field in TRACKED:
        old, new = prior.get(field), getattr(task, field, None)
        same = (old or "") == (new or "") if field == "title" else _fold(old) == _fold(new)
        if same:
            continue
        try:
            written.append(await _comment(task, field, old, new))
        except Exception:  # noqa: BLE001 — the save already happened; its history is best-effort
            logger.warning("[task-history] %s change on %s not recorded", field, task.id, exc_info=True)
    return written


async def _comment(task: Any, field: str, old: Any, new: Any):
    from flow_sdk.builtin.comment import Comment  # noqa: PLC0415
    from flow_sdk.tasks.identity import local_author  # noqa: PLC0415

    author = local_author()
    text = sentence(field, old, new, author=author)
    data = {"change": field, "from": old, "to": new, "author": author, "text": text}
    return await task.add_child_shared(Comment(raw_content=text, data=data))


def sentence(field: str, old: Any, new: Any, *, author: str = "") -> str:
    """The change as the thread says it. Handing over your own task is "Assigned"; taking it from someone
    else is "Reassigned"."""
    if field == "status":
        return f"Status: {label(new)}"
    if field == "title":
        return f"Renamed to {new}"
    if not new:
        return "Unassigned"
    return f"Reassigned to {new}" if old and _fold(old) != _fold(author) else f"Assigned to {new}"


def label(status: Any) -> str:
    return str(status or "").replace("_", " ").capitalize() or "None"


def _fold(value: Any) -> str:
    from flow_sdk.builtin.user import normalize_email  # noqa: PLC0415

    return normalize_email(str(value or "")) or ""


__all__ = ["TRACKED", "before", "label", "record", "sentence"]
