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
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.deployment import Deployment

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
) -> "AgenticProcess":
    """Run an agent on the machine its deployment places it on.

    Raises ``NotImplementedError`` for a non-local deployment rather than
    quietly running here. A silent local fallback is exactly how "it ran in the
    cloud" becomes a lie, and it would be invisible in the returned process.
    """
    # An agent placement is always node-backed, so this resolves; the fallback
    # keeps the lifecycle emission addressable rather than crashing the run if a
    # row ever arrives with a provider that is not.
    node_id = deployment.compute_node_id or "unknown"
    agent = await deployment.agent()
    agent_name = getattr(agent, "name", None) or str(deployment.parent_type_id)

    base = {
        "deployment_id": deployment.id,
        "agent": agent_name,
        "kind": deployment.kind,
        "prompt": prompt,
    }
    _emit(TAG_RUN_REQUESTED, node_id, base)

    if not deployment.is_local:
        _emit(TAG_RUN_FAILED, node_id, {**base, "error": "no transport to a remote node"})
        raise NotImplementedError(
            f"agent {agent_name!r} is deployed on compute node {node_id} "
            f"(kind {deployment.kind!r}), which cannot be reached from here yet. "
            "Remote runs need the inbound event relay; running it locally instead "
            "would misreport where it executed."
        )

    try:
        process = await deployment.launch(prompt, **options)
    except Exception as exc:
        _emit(TAG_RUN_FAILED, node_id, {**base, "error": str(exc)})
        raise

    _emit(TAG_RUN_STARTED, node_id, {**base, "process_id": process.id})
    return process
