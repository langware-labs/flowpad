"""Who is calling, in the task ledger's terms — resolved from the calling process, never claimed.

A ``flow task`` command names only its process (``FLOWPAD_EXECUTION_SCOPE``); the backend decides
what that process may act as:

* a process started to OWN a task (``context_data.task_id``) acts as that task's owner
  (``subagent:<name>``) — on that task only;
* a process an agent's placement started (``deployment_id``) acts as ``agent:<id>``;
* anything else is the local user, ``user:local``.

The caller's conversation (``target_typeid_str`` of a conversation-session process) is where a new
task reports back, and its project is where the task is stored.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

LOCAL_USER = "user:local"


@dataclass(frozen=True)
class Caller:
    principal: str
    process: Any = None
    #: The task this caller was started to own, or "".
    owned_task_id: str = ""
    agent_id: str = ""
    project_id: Optional[str] = None
    #: The conversation this caller's session is — where a task it creates reports back.
    conversation_id: str = ""


def agent_ref(agent_id: str) -> str:
    return f"agent:{agent_id}"


def subagent_ref(name: str) -> str:
    return f"subagent:{name}"


def ref_kind(ref: str) -> tuple[str, str]:
    """``"subagent:general-worker"`` → ``("subagent", "general-worker")``."""
    kind, _, value = (ref or "").partition(":")
    return kind, value


async def caller_of(process_typeid: str | None) -> Caller:
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

    raw = str(process_typeid or "").strip()
    process_id = raw.split("agentic_process-", 1)[1] if raw.startswith("agentic_process-") else raw
    process = await AgenticProcess.get_by_id(process_id) if process_id else None
    if process is None:
        return Caller(principal=LOCAL_USER)
    data = process.context_data or {}
    conversation = _conversation_of(process)
    task_id = str(data.get("task_id") or "")
    if task_id:
        from flow_sdk.builtin.task import Task  # noqa: PLC0415

        task = await Task.get_by_id(task_id)
        if task is not None and task.owner:
            return Caller(principal=task.owner, process=process, owned_task_id=task.id, project_id=process.project_id,
                          conversation_id=conversation)
    agent_id = await _agent_of(process)
    if agent_id:
        return Caller(principal=agent_ref(agent_id), process=process, agent_id=agent_id, project_id=process.project_id,
                      conversation_id=conversation)
    return Caller(principal=LOCAL_USER, process=process, project_id=process.project_id, conversation_id=conversation)


def _conversation_of(process) -> str:
    target = str(getattr(process, "target_typeid_str", "") or "")
    return target.split("conversation-", 1)[1] if target.startswith("conversation-") else ""


async def _agent_of(process) -> str:
    deployment_id = str(getattr(process, "deployment_id", "") or "")
    if not deployment_id:
        return ""
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

    deployment = await Deployment.get_by_id(deployment_id)
    parent = str(getattr(deployment, "parent_type_id", "") or "") if deployment is not None else ""
    return parent.split("agent-", 1)[1] if parent.startswith("agent-") else ""


__all__ = ["LOCAL_USER", "Caller", "agent_ref", "caller_of", "ref_kind", "subagent_ref"]
