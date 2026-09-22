"""A task owned by a subagent runs — its own headless worker, started, fed and kept in bounds here.

* **Start** (:func:`dispatch`) — on ``task.created`` with ``owner = subagent:<name>``: the subagent's
  prompt + the brief + "you own this task" become a headless ``AgenticProcess`` on the creator's
  harness (its worker type and model), marked ``context_data.task_id`` — which is what lets that
  process act as the task's owner in the ledger, and nothing else. The Flowpad assistant is mounted,
  so the ``task-management`` skill is there. The run is stamped on the task (``process_id``).
* **Capacity** — a creator runs at most :data:`MAX_RUNS` at once; beyond that a task waits
  ``submitted`` and starts when one finishes (:func:`dispatch_waiting`).
* **Budget** — ``budget_turns`` bounds the turns a run is given, ``budget_usd`` its spend
  (``AgenticProcess.total_cost_usd``); crossing either fails the task, and says why.
* **Stall** — a working task with no ledger entry for :data:`STALL_AFTER_S` is announced
  ``stalled`` once (:func:`check_stalls`), which wakes its creator.

A run is headless, so news delivered later (:mod:`delivery`) cold-resumes the same session.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from flow_sdk.schema.data_spec.task_spec import TaskStatus
from flow_sdk.tasks import ledger
from flow_sdk.tasks.identity import ref_kind

logger = logging.getLogger(__name__)

#: Runs one creator may have at once.
MAX_RUNS = 3
#: No ledger entry on a working task for this long → ``stalled``.
STALL_AFTER_S = 15 * 60
_LIVE = (TaskStatus.WORKING.value, TaskStatus.INPUT_REQUIRED.value)


def run_turns(process) -> int:
    return int((getattr(process, "context_data", None) or {}).get("task_turns") or 0)


async def live_runs(creator: str) -> int:
    """Tasks of ``creator`` that hold a run right now."""
    return sum(1 for t in await ledger.open_tasks(principal=creator) if t.creator == creator and t.process_id)


async def dispatch(task) -> Optional[str]:
    """Start the run a subagent-owned task needs. Returns the run's typeid, or ``None`` (not ours / waiting)."""
    kind, name = ref_kind(task.owner or "")
    if kind != "subagent" or task.process_id or task.status != TaskStatus.SUBMITTED.value:
        return None
    if await live_runs(task.creator or "") >= MAX_RUNS:
        logger.info("[tasks] %s waits: %s already runs %d", task.id, task.creator, MAX_RUNS)
        return None
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.builtin.subagent_loading import load_subagent  # noqa: PLC0415
    from flow_sdk.tasks.cos import staff_dir  # noqa: PLC0415

    creator_kind, creator_id = ref_kind(task.creator or "")
    creator = await Agent.get_by_id(creator_id) if creator_kind == "agent" else None
    spec = load_subagent(name, await staff_dir(creator) if creator is not None else None)
    if spec is None:
        await ledger.record(task, ledger.TaskEvent.FAILED, author=ledger.SYSTEM, text=f"No staff member named {name!r}.")
        return None
    process = await _run_for(task, name, spec)
    await ledger.attach_run(task, str(process.typeid))
    first = ledger.render_event({"task_id": task.id, "event": "created", "author": task.creator, "title": task.title,
                                 "text": await ledger.brief_of(task)})
    await give_turn(process, f"{first}\n\nYou own this task (id {task.id}). Begin with `flow task start {task.id}`.", task)
    return str(process.typeid)


async def dispatch_waiting(creator: str) -> list[str]:
    """Start whatever of ``creator``'s tasks waited for capacity, oldest first."""
    started = []
    for task in await ledger.open_tasks(principal=creator):
        if task.creator == creator and task.status == TaskStatus.SUBMITTED.value and not task.process_id:
            run = await dispatch(task)
            if run:
                started.append(run)
    return started


async def give_turn(process, prompt: str, task=None) -> bool:
    """One more turn for a run — refused (and the task failed) past its turn budget."""
    from flow_sdk.builtin.task import Task  # noqa: PLC0415

    task = task or await Task.get_by_id(str((process.context_data or {}).get("task_id") or ""))
    turns = run_turns(process) + 1
    if task is not None and task.budget_turns and turns > task.budget_turns:
        await ledger.record(task, ledger.TaskEvent.FAILED, author=ledger.SYSTEM,
                            text=f"Over its turn budget ({task.budget_turns}).")
        return False
    process.context_data = {**(process.context_data or {}), "task_turns": turns}
    await process.save()
    process.queue.enqueue(prompt, source="task")
    process._schedule_queue_drain("task")
    return True


async def check_budget(task) -> bool:
    """Fail a task whose run spent past ``budget_usd``. Returns whether it is still within budget."""
    if not task.budget_usd or not task.process_id:
        return True
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

    process = await AgenticProcess.get_by_id(task.process_id.split("agentic_process-", 1)[-1])
    spent = float(getattr(process, "total_cost_usd", 0) or 0) if process is not None else 0.0
    if spent <= task.budget_usd:
        return True
    await ledger.record(task, ledger.TaskEvent.FAILED, author=ledger.SYSTEM, cost_usd=spent,
                        text=f"Over its budget: ${spent:.2f} of ${task.budget_usd:.2f}.")
    return False


async def check_stalls(now: Optional[datetime] = None) -> list[str]:
    """Announce each working task quiet for :data:`STALL_AFTER_S` as ``stalled`` — once per quiet spell."""
    now = now or datetime.now(timezone.utc)
    stalled = []
    for task in await ledger.open_tasks():
        if task.status not in _LIVE:
            continue
        log = await ledger.comments(task)
        last = log[-1] if log else None
        when = _aware(getattr(last, "created_date", None))
        if last is None or (last.data or {}).get("task_event") == ledger.TaskEvent.STALLED.value:
            continue
        if when is not None and now - when >= timedelta(seconds=STALL_AFTER_S):
            await ledger.record(task, ledger.TaskEvent.STALLED, author=ledger.SYSTEM,
                                text=f"No update for {int((now - when).total_seconds() // 60)} minutes.")
            stalled.append(task.id)
    return stalled


async def _run_for(task, name: str, spec):
    from flow_sdk.builtin.agent import Agent, worker_type_value  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.flowpad_types.enums import ProcessKind  # noqa: PLC0415

    creator_kind, creator_id = ref_kind(task.creator or "")
    agent = await Agent.get_by_id(creator_id) if creator_kind == "agent" else None
    prompt = str(spec.data.get("prompt") or spec.data.get("prompt_text") or getattr(spec, "prompt_text", "") or "").strip()
    ownership = (
        f"You own task {task.id}: {task.title}. The task ledger is your only channel — use the "
        "task-management skill (owner.md). You never talk to the person."
    )
    cli_config = agent.to_agent_options().to_json() if agent is not None else {}
    cli_config.pop("agents_json", None)
    # The run works in this machine's record area, never the project's git tree: what it makes is the
    # task's until a person keeps it. A brief that names a project path is the person's own instruction.
    from flow_sdk.fs_store.record_paths import data_dir_for  # noqa: PLC0415

    workdir = data_dir_for("task", task.id) / "work"
    workdir.mkdir(parents=True, exist_ok=True)
    process = AgenticProcess(
        workdir=str(workdir),
        name=f"{name}: {task.title}"[:120],
        worker_type=worker_type_value(agent.worker_type) if agent is not None else None,
        project_id=task.project_id,
        pty_mode=False,
        visible=False,
        process_type=ProcessKind.EXECUTION.value,
        load_flowpad_assistant=True,
        cli_config=cli_config,
        target_typeid_str=await thread_session(task),
        context_data={"task_id": task.id, "instructions": "\n\n".join(p for p in (prompt, ownership) if p),
                      "launched_by_agent": getattr(agent, "name", "") or ""},
    )
    return await process.save()


async def thread_session(task) -> str:
    """The conversation of the task's thread on its creator's Tasks channel, as a session typeid —
    what the run targets, so the task thread shows the run live. Resolve-or-create through the same
    double-checked seam projection uses, so this and the ``created`` event's projection converge on
    one thread whichever lands first. No Tasks channel (the creator is not an agent with Chief of
    Staff on): the task itself."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
    from flow_sdk.ingest.bus_sources import principal_channel_for  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import channel_of, owner_of, resolve_thread  # noqa: PLC0415

    fallback = str(task.typeid)
    runtime = principal_channel_for("task.created")
    if runtime is None or not task.creator:
        return fallback
    row = await DataSource.find_for_account(runtime.provider, runtime.cls.identity_config_key, task.creator)
    if row is None:
        return fallback
    source = await runtime.open(row)
    key = source.thread(task.id).key  # type: ignore[attr-defined] — a principal channel names its threads
    thread = await resolve_thread(channel_of(row), key, await owner_of(row), data_source_id=str(row.id),
                                  title=task.title or key)
    if not thread.conversation_id:
        return fallback
    return str(TypeId(type=EntityType.CONVERSATION.value, id=str(thread.conversation_id)))


def _aware(value):
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


__all__ = ["MAX_RUNS", "STALL_AFTER_S", "check_budget", "check_stalls", "dispatch", "dispatch_waiting", "give_turn", "live_runs", "thread_session"]
