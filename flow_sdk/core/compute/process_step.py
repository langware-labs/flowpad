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

It answers with a ``PromptResult``: ``text`` is what the agent said, and
``executor`` names the process whenever one exists — even on failure — so a
caller can link to it, or prompt that same process again.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Callable, Optional

from pydantic import Field

from flow_sdk.schema.data_spec.returned_value_spec import PromptResult
from flow_sdk.schema.data_spec.spec import DataSpec

logger = logging.getLogger(__name__)


class ProcessProgress(DataSpec):
    """One tick of a step's agent, in the wizard's vocabulary.

    Its own type rather than a raw ``WorkerStatus`` so the runner stays free of
    process imports — the property that keeps its tests in milliseconds.
    """

    text: str
    counters: dict = Field(default_factory=dict)
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
            # pydantic copies it on construction; copying here too was twice.
            counters = getattr(node, "counters", {}) or {}
    except Exception:  # noqa: BLE001 — a status line is never worth a failure
        logger.debug("could not read agent status for %s", process_id, exc_info=True)
    return ProcessProgress(text=text, counters=counters, blocked=blocked)


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
    executor: Optional[str] = None,
) -> PromptResult:
    """Spawn a headless agent process for one step and wait for it to settle.

    With ``executor`` — an earlier answer's ``agentic_process-<id>`` — prompt
    THAT process instead: a further turn in the same session. Nothing is
    spawned, so the agent, name and context of the first turn stand.

    ``on_status`` is called with a `ProcessProgress` as the agent works, so the
    step's row says what is happening rather than sitting still for the whole
    timeout. It rides `wait()`'s existing 2s poll — no new budget.
    """
    if executor:
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess  # noqa: PLC0415
        from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
        from flow_sdk.schema.types import EntityType  # noqa: PLC0415

        if not TypeId.is_typeid(executor) or TypeId(executor).type != EntityType.AGENTIC_PROCESS.value:
            return PromptResult.not_yet(f"{executor!r} is not an agent process — it cannot take a turn.", ran=False)
        process = await AgenticProcess.get_by_typeid(executor)
        if process is None:
            return PromptResult.not_yet(f"The agent process {executor} no longer exists.", ran=False)
        return await _prompt_and_wait(process, prompt, timeout_seconds=timeout_seconds, on_status=on_status)

    from flow_sdk.builtin.agent_registry import get_agent_local_deployment  # noqa: PLC0415
    from flow_sdk.core.capabilities.registry import resolve_builtin_worker_type  # noqa: PLC0415

    try:
        # The bare box a wizard is meant to fix often has no harness yet: the selected harness
        # when it is installed, else the bootstrap worker that needs none.
        worker_type = await resolve_builtin_worker_type()
    except Exception as exc:  # noqa: BLE001
        return PromptResult.not_yet(f"No coding-agent harness is available to run this: {exc}", ran=False)

    try:
        deployment = await get_agent_local_deployment(agent)
    except LookupError as exc:
        return PromptResult.not_yet(str(exc), ran=False)

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
        return PromptResult.not_yet(f"Could not start the agent: {exc}", ran=False)

    if on_status is not None:
        # Immediately: the row should move when the process exists, not two
        # seconds later when the first poll lands.
        on_status(ProcessProgress(text="starting the agent"))
    return await _prompt_and_wait(process, prompt, timeout_seconds=timeout_seconds, on_status=on_status)


async def _prompt_and_wait(
    process: Any,
    prompt: str,
    *,
    timeout_seconds: float,
    on_status: Optional[Callable[[ProcessProgress], None]],
) -> PromptResult:
    """One turn: prompt, then wait for the process to settle."""
    process_id = str(process.id)
    executor = str(process.typeid)
    started = time.monotonic()
    try:
        taken = await process.send_turn(prompt)
    except Exception as exc:  # noqa: BLE001
        return PromptResult.not_yet(f"The agent could not take the prompt: {exc}", ran=False, executor=executor)
    if not taken.ok:
        return taken

    try:
        await process.wait(
            timeout=timeout_seconds,
            on_status=(
                (lambda ws: on_status(_progress_for(process_id, ws)))
                if on_status is not None else None
            ),
        )
    except TimeoutError:
        return PromptResult.not_yet(
            f"The agent did not finish within {timeout_seconds:.0f}s.",
            timed_out=True, executor=executor, duration_s=time.monotonic() - started,
        )
    except Exception as exc:  # noqa: BLE001
        return PromptResult.not_yet(
            f"The agent run failed: {exc}", executor=executor, duration_s=time.monotonic() - started,
        )

    # HOW the agent stopped, read the one way AgenticProcess.run reads it: an
    # error or an interrupt is NOT_YET, whatever it wrote on the way down. (It
    # was always `satisfied` here, so an agent op with no completion check — a
    # continuation, say — reported a crashed agent as done.) Even a clean stop is
    # NOT proof the work landed; that is what the completion check is for.
    from flow_sdk.builtin.agentic_process.agentic_process import _build_run_result  # noqa: PLC0415

    return _build_run_result(process).model_copy(update={"duration_s": time.monotonic() - started})
