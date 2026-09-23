"""Task news → the participants' agentic processes. One rule for both sides of a task.

Every ``task.*`` event reaches each participant but its author:

* an **agent** (``agent:<id>``, creator or owner) hears it on its **Tasks channel** — the
  ``task_manager`` source, fed by the bus (``flow_sdk/ingest/bus_sources.py``) — and its serve loop
  answers in the task's origin session. Nothing to do here.
* a **run** (the subagent process working a task) hears it on its process's prompt queue, rendered
  exactly as the Tasks channel renders it; the headless drain resumes its session. Only what
  concerns the owner goes there: a ``replied`` answer, a creator's ``note``, a ``canceled``.
"""

from __future__ import annotations

import logging

from flow_sdk.tasks import ledger
from flow_sdk.tasks.identity import ref_kind

logger = logging.getLogger(__name__)

#: Events a run is told about — the creator's side of the conversation.
FOR_THE_RUN = frozenset({"replied", "note", "canceled"})


async def deliver(data: dict) -> bool:
    """Deliver one task event to the run working the task, when it concerns it. Returns whether it went."""
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.builtin.task import Task  # noqa: PLC0415
    from flow_sdk.tasks.dispatch import dispatch, give_turn  # noqa: PLC0415

    event, author = str(data.get("event") or ""), str(data.get("author") or "")
    if event not in FOR_THE_RUN or author == data.get("owner") or ref_kind(str(data.get("owner") or ""))[0] != "subagent":
        return False
    task = await Task.get_by_id(str(data.get("task_id") or ""))
    if task is None:
        return False
    run = await AgenticProcess.get_by_id(task.process_id.split("agentic_process-", 1)[-1]) if task.process_id else None
    if run is None:
        # Nobody is working it (the run is gone): an answer restarts it; anything else waits in the log.
        return bool(event == "replied" and await dispatch(task))
    return await give_turn(run, ledger.render_event(data), task)


__all__ = ["FOR_THE_RUN", "deliver"]
