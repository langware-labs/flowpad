"""Running an agent — the routing seam and its lifecycle events.

A run is addressed to a MACHINE, not to "here". `dispatch_agent_run` takes a
deployment, reads the compute node it places the agent on, and routes:

    local  -> spawn in this process (today)
    remote -> not yet routable (raises)

That single branch is the whole point of this module. Everything above it —
the HTTP action, the UI button — already speaks in terms of "run this agent's
deployment", so when a transport to a remote node's bus exists, only the branch
below changes and no caller moves.

**Why a direct call and not a bus message, today.** The intended end state is
that a run is a FlowEvent targeted at ``compute_node:<id>`` which that node's
bus handles. The substrate for that already exists — the bus is
``(tag, target)``-addressed, `target_of` mints the colon form, subscriptions
filter on target, and ``sandbox`` is a tier. Two things are missing:

  1. ``TagEventBus.emit`` is fire-and-forget and returns None when nothing
     matched. A run with no registered handler would be a SILENT no-op, and the
     caller needs a process id back (or a real error) to be useful.
  2. ``ws_forward`` is strictly one-way (backend -> app, allowlisted); there is
     no inbound relay to carry an event to another tier's bus at all.

So the *command* is a call that acknowledges, and the *lifecycle* is emitted as
node-addressed events alongside it. A future in-sandbox handler subscribes to
``agent.run.requested`` with ``target=compute_node:<its own id>`` and needs no
change to the tags or the addressing — only (2) has to land.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.schema.data_spec.returned_value_spec import PromptResult

logger = logging.getLogger(__name__)

#: Lifecycle tags. Node-addressed, so an observer (or a future remote executor)
#: filters by the machine the work belongs to.
TAG_RUN_REQUESTED = "agent.run.requested"
TAG_RUN_STARTED = "agent.run.started"
TAG_RUN_FAILED = "agent.run.failed"


def _emit(tag: str, node_id: str, data: dict[str, Any]) -> None:
    """Best-effort lifecycle emission — never fails the run that triggered it.

    Mirrors ``node_on_tag.emit_node_transition``: an observer must not be able
    to break the thing it observes.
    """
    try:
        from flow_sdk.tags import emit_tag  # noqa: PLC0415
        from flow_sdk.tags.envelope import target_of  # noqa: PLC0415

        emit_tag(tag, target_of("compute_node", node_id), data)
    except Exception:
        logger.debug("agent run emission failed for %s", tag, exc_info=True)


async def dispatch_agent_run(
    deployment: "Deployment",
    prompt: str,
    **options: Any,
) -> "PromptResult":
    """Run an agent on the machine its deployment places it on — answered as a
    ``PromptResult`` whose ``executor`` names the process. Never raises for an
    outcome.

    A non-local deployment answers NOT_APPLICABLE rather than quietly running
    here. A silent local fallback is exactly how "it ran in the cloud" becomes a
    lie, and it would be invisible in the answer.
    """
    from flow_sdk.schema.data_spec.returned_value_spec import PromptResult  # noqa: PLC0415
    # An agent placement is always node-backed, so this resolves; the fallback
    # keeps the lifecycle emission addressable rather than crashing the run if a
    # row ever arrives with a provider that is not.
    node_id = deployment.compute_node_id or "unknown"
    agent = await deployment.agent()
    agent_name = getattr(agent, "name", None) or str(deployment.parent_type_id)

    base = {
        "deployment_id": deployment.id,
        "agent": agent_name,
        "element": deployment.element_type,
        "prompt": prompt,
    }
    _emit(TAG_RUN_REQUESTED, node_id, base)

    if not deployment.is_local:
        _emit(TAG_RUN_FAILED, node_id, {**base, "error": "no transport to a remote node"})
        return PromptResult.not_applicable(
            f"agent {agent_name!r} is deployed on compute node {node_id}, "
            "which cannot be reached from here yet. "
            "Remote runs need the inbound event relay; running it locally instead "
            "would misreport where it executed."
        )

    answer = await deployment.launch(prompt, **options)
    if not answer.ok:
        _emit(TAG_RUN_FAILED, node_id, {**base, "error": answer.detail})
        return answer
    _emit(TAG_RUN_STARTED, node_id, {**base, "process_id": process_id_of(answer)})
    return answer


def process_id_of(answer) -> "str | None":
    """The process id an answer's ``executor`` names, or None."""
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    executor = getattr(answer, "executor", None)
    if executor:
        return TypeId(executor).id
    if getattr(answer, "steps", None):
        found = answer.first_executor()
        return TypeId(found).id if found else None
    return None


async def create_agentic_process_from_agent(agent, prompt: str = "", *, place=None, **options) -> "AgenticProcess":
    """Project *agent* onto an AgenticProcess. Not saved, not started.

    The primitive every launch of an agent builds on. Every field the agent declares (worker,
    model, permissions, system prompt, MCP servers, dirs) comes from the Agent; only per-run
    concerns (``visible``, ``process_type``, ``context_data``, ``workdir``, ``pty_mode``, …) are
    accepted here and passed through. *place* is a placement's overrides (agent.json ``places``):
    ``Deployment.create_process`` passes its own; a run that belongs to no placement (a task run,
    ``tasks.dispatch``) passes none.
    """
    from flow_sdk.builtin.agent import worker_type_value  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process.agentic_process import selected_worker_type  # noqa: PLC0415
    from flow_sdk.flowpad_types.enums import ProcessKind  # noqa: PLC0415

    place_mcp = place.mcp_servers if place is not None else None
    if place is not None:
        agent = agent.model_copy(update={k: v for k, v in place.overrides().items() if k != "mcp_servers"})

    # A per-run worker override has to reach BOTH sides — the options object
    # (dispatched on the driver key) and the process field (a WorkerType
    # enum value). Applying it to only one is how you get a codex-flavoured
    # options bundle handed to a claude process.
    worker_override = options.pop("worker_type", None)
    # Transport, not identity: a chat surface streams JSON, a one-shot run
    # prints. Goes through the constructor (see ``to_agent_options``).
    opts = agent.to_agent_options(worker_type=worker_override, output_format=options.pop("output_format", None))

    # The agent's system prompt goes in via ``context_data.instructions`` —
    # the ``INSTRUCTIONS`` layer of ``system_prompt.compose_layers``, which
    # ``prepare_system_instruction_assets`` projects per vendor (CLAUDE.md /
    # AGENTS.md / copilot instructions / developer_instructions).
    context_data = {**(options.pop("context_data", None) or {})}
    if agent.system_prompt:
        existing = str(context_data.get("instructions") or "").strip()
        context_data["instructions"] = "\n\n".join(
            p for p in (agent.system_prompt.strip(), existing) if p
        )
    context_data.setdefault("launched_by_agent", agent.name)
    # Chief of Staff mode — CoS.md, the skill, the native staff roster. Off: nothing changes.
    from flow_sdk.tasks.cos import apply_to_launch, staff_dir  # noqa: PLC0415

    cli_config = opts.to_json()
    cos_options = apply_to_launch(
        agent, context_data=context_data, cli_config=cli_config, worker_type=worker_override or agent.worker_type,
        project_dir=await staff_dir(agent) if getattr(agent, "chief_of_staff", False) else None,
    )

    # Declared -> attached, BEFORE the folder is read below. ``mcp_servers``
    # on agent.json is the authored intent; ``mcp_assets()`` is the structural
    # attachment a launch resolves, and this is the one place that turns the
    # first into the second. Idempotent, so a re-launch of an unchanged
    # agent writes nothing.
    await agent.attach_declared_mcp_servers()

    # An agent acting in ANOTHER project's checkout still needs its own files: mount
    # its home and say where it is, so a path in its prompt resolves there.
    acting_project_id = options.pop("project_id", None) or agent.project_id
    additional_dirs = list(agent.additional_dirs or [])
    # New sessions resolve the agent's current declarations before the worker
    # snapshots context. The owning project reconciles its complete graph;
    # this projection adds only the agent's closure, including when it acts
    # in another project. Resolution never grants consent to run setup.
    if agent.asset_ref and (Path(agent.asset_ref) / "flow.json").is_file() and (agent.project_id or acting_project_id):
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        source_project = await Project.get_by_id(agent.project_id or acting_project_id)
        if source_project is not None:
            dependencies = await source_project.dependencies(asset=str(agent.typeid), fetch=True)
            for dependency in dependencies:
                if dependency.state == "ready" and dependency.local_path and dependency.local_path not in additional_dirs:
                    additional_dirs.append(dependency.local_path)
    home = await _foreign_home(agent, acting_project_id)
    if home:
        if home not in additional_dirs:
            additional_dirs.append(home)
        context_data["instructions"] = "\n\n".join(
            p for p in (str(context_data.get("instructions") or "").strip(), home_line(home)) if p
        )

    process = AgenticProcess(
        name=options.pop("name", None) or f"{agent.name}: {prompt[:40]}",
        workdir=options.pop("workdir", None),
        visible=bool(options.pop("visible", False)),
        # Headless by default: pty_mode=False routes prompt() to the
        # print-mode driver, no PTY or Shell. Callers wanting the
        # interactive worker pass pty_mode=True and start it themselves.
        pty_mode=options.pop("pty_mode", False),
        process_type=options.pop("process_type", ProcessKind.EXECUTION.value),
        worker_type=worker_type_value(worker_override or agent.worker_type or await selected_worker_type()),
        project_id=acting_project_id,
        load_flowpad_assistant=cos_options.get("load_flowpad_assistant", agent.load_flowpad_assistant),
        additional_dirs=additional_dirs,
        # The agent's MCP assets, resolved from its folder. Set on the
        # constructor rather than via ``process.add_mcp`` because this verb
        # is documented "not saved" and ``add_mcp`` saves. A process may
        # still add its own on top; ``resolved_mcp_servers`` dedupes by name.
        # Reads the folder AFTER the attach above, which is what puts the
        # editor's declared ids there.
        mcp_servers=await _place_mcp_specs(agent, place_mcp),
        cli_config=cli_config,
        instruction_content=prompt,
        context_data=context_data,
        **options,
    )
    return process


async def _place_mcp_specs(agent, names: "list[str] | None") -> list:
    """The MCP servers a launch gets: the agent's own, or a place's named set.

    A place names servers (names travel between machines; ids do not). A name the
    agent already carries uses that attached copy; otherwise the first Mcp asset of
    that name on this machine. A name that resolves nowhere is skipped with a warning
    — a dangling override must not make the agent unlaunchable.
    """
    specs = await agent.resolved_mcp_specs()
    if names is None:
        return specs
    from flow_sdk.builtin.mcp import Mcp  # noqa: PLC0415

    by_name = {spec.name: spec for spec in specs}
    chosen = []
    for name in names:
        spec = by_name.get(name)
        if spec is None:
            rows = await Mcp.get_all({"match": {"name": name}})
            spec = rows[0].to_spec() if rows else None
        if spec is None:
            logger.warning("place override names MCP server %r, which does not resolve here — skipped", name)
            continue
        chosen.append(spec)
    return chosen


def home_line(home: str) -> str:
    """The one sentence that tells an agent where its own files are."""
    return f"Your own files are in {home}; paths in your instructions are relative to it."


async def _foreign_home(agent, acting_project_id: str | None) -> str | None:
    """The agent's own folder when it lies outside the acting project's folder, else ``None``.

    ``agent.home()`` knows a project's folder or a repository. An agent in a plain
    dependency folder (no git, not a project of its own) has neither — but the acting
    project depends on that folder, so the deepest of its dependency roots holding the
    agent IS its home."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import canonical_posix_path, is_path_under  # noqa: PLC0415

    acting = await Project.get_by_id(acting_project_id) if acting_project_id else None
    mount = getattr(acting, "fs_storage_mount_path", None)
    home = await agent.home()
    if not home and acting is not None and agent.asset_ref:
        try:
            ref = canonical_posix_path(agent.asset_ref)
        except OSError:
            ref = ""
        holding = [r for r in acting.direct_context_roots()[1:] if ref and is_path_under(ref, r)]
        home = max(holding, key=len) if holding else None
    if not home:
        return None
    if mount and is_path_under(home, canonical_posix_path(mount)):
        return None
    return home
