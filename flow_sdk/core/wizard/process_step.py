"""Hand one wizard step to an agent, and wait for it.

This is the four-line core of ``run_capability_install_process``
(``flow_sdk/core/capabilities/registry.py:663``) with one deliberate change:
the process is **awaited**, not monitored.

That function returns the moment the worker starts and lets a background
monitor settle the verdict, because a browser needs the process id while the
run is still live. A wizard step has no such caller — the next step's
precondition depends on this one having finished — so the runner blocks here.

``run_capability_install_process`` is deliberately NOT reused: it is welded to
``CapabilitySpec``, mutates a ``Capability`` row's ``last_setup``/``state``, and
schedules a fire-and-forget re-discovery. A wizard step wants none of that.

Nothing here raises. A machine with no harness capability resolved is the
NORMAL state of the bare box a wizard exists to fix, so "no harness" has to be
a legible failed step, not a traceback that takes the whole run with it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProcessProgress:
    """One tick of a step's agent, in the wizard's vocabulary.

    Its own type rather than a raw ``WorkerStatus`` so the runner stays free of
    process imports — the property that keeps its tests in milliseconds.
    """

    text: str
    counters: dict = field(default_factory=dict)
    blocked: bool = False


#: Worker states collapse to a handful of words on purpose. A row that flickers
#: between "thinking" and "using tool" and "working" is noisier than one that
#: says "working", and the fine-grained labels already exist in the frontend
#: where there is a real process entity to render them from.
_VERB_BY_STATE = {
    "blocked": "waiting for you",
    "failed": "finishing",
    "completed": "finishing",
    "cancelled": "finishing",
}


def _progress_for(process_id: str, worker_status: Any) -> ProcessProgress:
    """What to say about the agent right now. Never raises, never mints."""
    text, counters, blocked = "working", {}, False
    try:
        from flow_sdk.activity.progress_monitor import monitor  # noqa: PLC0415
        from flow_sdk.builtin.agentic_process.activity_bridge import (  # noqa: PLC0415
            PROCESS_ACTIVITY_PATH, _state_for, subject_for,
        )

        state = _state_for(worker_status)
        blocked = getattr(state, "value", str(state)) == "blocked"
        text = _VERB_BY_STATE.get(getattr(state, "value", str(state)), "working")
        # `node`, not `get`: a READ must not mint. Minting here would fabricate
        # a phantom row on the footer chip for a process that has not reported.
        node = monitor.node(PROCESS_ACTIVITY_PATH, subject_entity=subject_for(process_id))
        if node is not None:
            if getattr(node, "current_item", None):
                text = f"{text} · {node.current_item}"
            counters = dict(getattr(node, "counters", {}) or {})
    except Exception:  # noqa: BLE001 — a status line is never worth a failure
        logger.debug("could not read agent status for %s", process_id, exc_info=True)
    return ProcessProgress(text, counters, blocked)


@dataclass(frozen=True)
class ProcessResult:
    """What the agent step did. ``process_id`` is set even when ``ok`` is False,
    so a caller can always link to the run that failed."""

    process_id: Optional[str]
    ok: bool
    message: str = ""


async def launch_step_process(
    *,
    agent: str,
    prompt: str,
    name: str,
    workdir: Path,
    context_data: Optional[dict] = None,
    target_typeid_str: str = "",
    timeout_seconds: float = 1800.0,
    on_status: Optional[Callable[[ProcessProgress], None]] = None,
) -> ProcessResult:
    """Spawn a headless agent process for one step and wait for it to settle.

    ``on_status`` is called with a `ProcessProgress` as the agent works, so the
    step's row says what is happening rather than sitting still for the whole
    timeout. It rides `wait()`'s existing 2s poll — no new budget.
    """
    from flow_sdk.builtin.agent_registry import get_agent_local_deployment  # noqa: PLC0415
    from flow_sdk.core.capabilities.registry import resolve_default_worker_type  # noqa: PLC0415
    from flow_sdk.responses.response import ApiFailResponse  # noqa: PLC0415

    try:
        worker_type = await resolve_default_worker_type()
    except Exception as exc:  # noqa: BLE001
        # The bare box a wizard is meant to fix often has no harness yet. Say so.
        return ProcessResult(None, False, f"No coding-agent harness is available to run this step: {exc}")

    try:
        deployment = await get_agent_local_deployment(agent)
    except LookupError as exc:
        return ProcessResult(None, False, str(exc))

    try:
        process = await deployment.create_process(
            prompt,
            worker_type=worker_type,
            name=name,
            workdir=str(workdir),
            context_data={**(context_data or {}), "wizard_step_prompt": prompt},
            target_typeid_str=target_typeid_str,
        )
        await process.save(notify=True)
    except Exception as exc:  # noqa: BLE001
        return ProcessResult(None, False, f"Could not start the step's agent: {exc}")

    process_id = str(process.id)
    if on_status is not None:
        # Immediately: the row should move when the process exists, not two
        # seconds later when the first poll lands.
        on_status(ProcessProgress("starting the agent"))
    try:
        start = await process.prompt(prompt)
    except Exception as exc:  # noqa: BLE001
        return ProcessResult(process_id, False, f"Agent failed to start: {exc}")
    if isinstance(start, ApiFailResponse):
        return ProcessResult(process_id, False, getattr(start, "message", "Agent failed to start"))

    try:
        await process.wait(
            timeout=timeout_seconds,
            on_status=(
                (lambda ws: on_status(_progress_for(process_id, ws)))
                if on_status is not None else None
            ),
        )
    except TimeoutError:
        return ProcessResult(process_id, False, f"Agent did not finish within {timeout_seconds:.0f}s")
    except Exception as exc:  # noqa: BLE001
        return ProcessResult(process_id, False, f"Agent run failed: {exc}")

    # Reaching a terminal state is NOT proof the work landed — that is what the
    # step's `verify` is for. All this reports is that the agent stopped.
    return ProcessResult(process_id, True, "agent finished")
