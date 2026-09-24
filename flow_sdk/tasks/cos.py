"""Chief of Staff mode — what an agent with ``chief_of_staff`` on is told, and nothing when it is off.

Everything the mode changes goes through :func:`apply_to_launch`, called by
``Deployment.create_process`` — the one door every way an agent runs passes (chat, a channel turn,
a voice call, a scheduled launch):

* ``CoS.md`` (``task-management/chief-of-staff.md``) joins the worker's instructions, rendered for
  this harness: a harness that spawns subagents (``driver.spawns_subagents``) is told to run quick
  jobs on them; one that cannot is told to make even those a task;
* the Flowpad assistant is mounted, so the ``task-management`` skill is there to use;
* on a spawning harness the agent's staff (its ``subagents`` + the default ``general-worker``) are
  registered natively (``--agents``);
* ``context_data.chief_of_staff`` marks the process, so each turn's instructions carry its open
  tasks (:func:`open_tasks_block`, read by ``AgenticProcess.resolve_system_instructions``).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: The line CoS.md opens with — how anything (a test, a mock worker) recognizes CoS instructions.
COS_MARKER = "<!-- chief-of-staff -->"
DEFAULT_STAFF = "general-worker"

_SKILL_DIR = Path(__file__).resolve().parent.parent / "system_projects" / "flowpad_assistant" / ".claude" / "skills" / "task-management"
_SPAWNS = (
    "run it yourself on one of your staff with your native subagent tool (the Agent tool), in this same "
    "turn, then answer with what it found."
)
_NO_SPAWN = (
    "your harness cannot run a subagent itself — treat it as C and create a task (it still beats "
    "blocking the conversation)."
)


def staff_of(agent, project_dir: Optional[str] = None) -> list[str]:
    """The agent's staff that can actually be found: its declared subagents (from its project, the
    user's agents, or the system's), and the default worker last. A name that resolves nowhere is
    left out — and logged — so the agent is never told about staff it cannot reach."""
    from flow_sdk.builtin.subagent_loading import load_subagent  # noqa: PLC0415

    names = [str(n).strip() for n in (getattr(agent, "subagents", None) or []) if str(n).strip()]
    found = []
    for name in dict.fromkeys(names):
        if load_subagent(name, project_dir) is None:
            logger.warning("chief of staff %s: staff subagent %r not found", getattr(agent, "name", ""), name)
            continue
        found.append(name)
    return [*found, *([] if DEFAULT_STAFF in found else [DEFAULT_STAFF])]


async def staff_dir(agent) -> Optional[str]:
    """Where the agent's own staff live: its project's mount (``.claude/agents`` under it)."""
    project_id = getattr(agent, "project_id", None)
    if not project_id:
        return None
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    project = await Project.get_by_id(project_id)
    return getattr(project, "fs_storage_mount_path", None) if project is not None else None


def instructions_for(agent, *, spawns: bool, project_dir: Optional[str] = None) -> str:
    template = (_SKILL_DIR / "chief-of-staff.md").read_text(encoding="utf-8")
    roster = ", ".join(f"`subagent:{n}`" for n in staff_of(agent, project_dir))
    return template.replace("{spawn_rule}", _SPAWNS if spawns else _NO_SPAWN).replace("{roster}", roster).strip()


def native_roster(agent, project_dir: Optional[str] = None) -> dict:
    """``--agents`` JSON for the agent's staff."""
    from flow_sdk.assets.types.subagent import subagent_to_cli_json  # noqa: PLC0415
    from flow_sdk.builtin.subagent_loading import load_subagent  # noqa: PLC0415

    out: dict = {}
    for name in staff_of(agent, project_dir):
        rec = load_subagent(name, project_dir)
        if rec is not None:
            out.update(subagent_to_cli_json(rec))
    return out


def apply_to_launch(agent, *, context_data: dict, cli_config: dict, worker_type: Any,
                    project_dir: Optional[str] = None) -> dict:
    """Make a launch a Chief of Staff launch. Returns the process options it changes. A no-op when off."""
    if not getattr(agent, "chief_of_staff", False):
        return {}
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import get_driver  # noqa: PLC0415

    spawns = bool(getattr(get_driver(worker_type), "spawns_subagents", False))
    existing = str(context_data.get("instructions") or "").strip()
    context_data["instructions"] = "\n\n".join(
        p for p in (existing, instructions_for(agent, spawns=spawns, project_dir=project_dir)) if p
    )
    context_data["chief_of_staff"] = True
    if spawns:
        roster = native_roster(agent, project_dir)
        if roster:
            cli_config["agents_json"] = roster
    return {"load_flowpad_assistant": True}


async def sync_tasks_channel(agent):
    """The agent's Tasks channel follows the checkbox: bound and listening when Chief of Staff is on,
    paused when off (its threads stay). Writes only what changed. Returns the source, or ``None``.

    "The Tasks channel" is whichever bus-fed driver carries ``task.*`` as one channel per principal —
    found by what it declares (:func:`flow_sdk.ingest.bus_sources.principal_channel_for`), not by name."""
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415
    from flow_sdk.ingest.bus_sources import principal_channel_for  # noqa: PLC0415
    from flow_sdk.tasks.identity import agent_ref  # noqa: PLC0415

    runtime = principal_channel_for("task.created")
    if runtime is None:
        logger.warning("chief of staff: no channel carries task events — is the Tasks driver loaded?")
        return None
    provider = runtime.provider
    key = runtime.cls.identity_config_key
    principal = agent_ref(agent.id)
    existing = await DataSource.find_for_account(provider, key, principal)
    if not getattr(agent, "chief_of_staff", False):
        if existing is not None and existing.status != SourceStatus.DISABLED.value:
            existing.status = SourceStatus.DISABLED.value
            await existing.save()
        return existing
    if existing is None:
        driver = DataDriver.loaded(provider)
        existing = driver.create_source(driver.create_config(**{key: principal}), name=f"{agent.name or agent.id} · tasks")
        existing.owner = agent.typeid
    # The agent's own address on this channel: its own task moves (created, replied) are never news to it.
    wanted = {"status": SourceStatus.ACTIVE.value, "inbound_allowed_senders": [], "account_key": principal,
              "account_identities": [principal]}
    changed = [f for f, v in wanted.items() if getattr(existing, f, None) != v]
    if not changed and existing.exist_in_db:
        return existing
    for field in changed:
        setattr(existing, field, wanted[field])
    return await existing.save()


async def open_tasks_block(process) -> str:
    """The CoS's open tasks, for this turn's instructions — the ledger it answers "how's it going" from."""
    from flow_sdk.tasks import ledger  # noqa: PLC0415
    from flow_sdk.tasks.identity import caller_of  # noqa: PLC0415

    caller = await caller_of(str(process.typeid))
    tasks = await ledger.open_tasks(principal=caller.principal)
    if not tasks:
        return "# Your open tasks\nNone."
    lines = ["# Your open tasks", "(the ledger right now — quote it; `flow task show <id>` for the log)"]
    for task in tasks:
        here = " · this conversation" if caller.conversation_id and task.origin_conversation == caller.conversation_id else ""
        lines.append(f"- {task.id} · {task.status} · {task.owner} · {task.title}{here}")
    return "\n".join(lines)


__all__ = ["COS_MARKER", "DEFAULT_STAFF", "apply_to_launch", "sync_tasks_channel", "instructions_for", "native_roster", "open_tasks_block", "staff_dir", "staff_of"]
