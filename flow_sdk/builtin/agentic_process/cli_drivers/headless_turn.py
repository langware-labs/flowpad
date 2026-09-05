"""The shared scaffold for one headless (print-mode) turn.

Every vendor driver's ``headless_prompt`` ends the same way: register the worker,
schedule a task that drains it into the process, and make absolutely sure the
prompt slot is released on every exit path. That tail was copied four times.

**Why this is a function and not a base class.** ``WorkerDriver`` is a
*structural* Protocol, and two contract tests assert on the ABSENCE of
attributes — ``test_cli_driver_contract.py`` checks
``not hasattr(CodexDriver, "report_event")`` and
``not hasattr(OpenCodeDriver, "preassign_interactive_session_id")``. A base class
would grant those attributes to every driver and break both. A free function
grants nothing.

**Where the seam is.** This helper begins at ``register_prompt_worker``.
Everything before it — building the ``AgenticContext``, resolving env and
secrets, the resume gate, model overrides, config generation, and any
preassigned session id — stays in the vendor's own prologue, because that work
genuinely differs per vendor. Keeping the seam here also means
``apply_worker_secret_env`` is still imported into each driver's namespace,
which ``test_agentic_process_turn_cleanup.py`` monkeypatches by module.

**The invariant this exists to protect.** Between ``register_prompt_worker`` and
``asyncio.create_task``, THIS frame owns the worker slot: the caller's admission
``finally`` can no longer clean it, because registration popped the admission and
moved ownership into ``_PROMPT_WORKERS``. A raise in that window leaks the slot
and pins ``prompt_worker_active`` True forever — a permanent 409 plus a stuck
busy flag. Four copies of that protocol meant four places to get it wrong.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Awaitable, Callable

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    AgenticWorker,
    WorkerSpawnError,
    latch_spawn_failure,
)
from flow_sdk.responses.response import ApiSuccessResponse

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerDriver
    from flow_sdk.responses.response import ApiResponse


async def run_headless_turn(
    driver: "WorkerDriver",
    process: "AgenticProcess",
    worker: AgenticWorker,
    *,
    prompt: str,
    context: AgenticContext,
    logger: logging.Logger,
    save_running_status: bool = True,
    emit_failure_level: int = logging.DEBUG,
    on_turn_finally: Callable[[], Awaitable[None]] | None = None,
) -> "ApiResponse":
    """Register ``worker``, schedule its turn, and guarantee slot release.

    ``driver`` supplies the three strings that used to be passed separately and
    were mechanically derivable from it all along: the log prefix
    (``<ClassName>.headless_prompt``), the asyncio task name
    (``<driver.name>-<short id>``, so a hung turn is attributable), and the
    worker name in the response. Taking the driver rather than inheriting from a
    base class is deliberate — see the module docstring.

    ``logger`` stays explicit rather than being derived from ``driver``: it is
    the CALLING DRIVER's logger, not this module's. Passing it keeps every
    record under ``…cli_drivers.<vendor>.driver``; taking this module's would
    silently move them all and break per-vendor log filters and ``caplog``
    assertions.

    ``save_running_status`` — flip the process to RUNNING. Claude passes False
    because it saves *before* registering the worker, and that ordering is
    preserved by leaving the save in its prologue.

    ``emit_failure_level`` — claude logs a failed ``emit_flow_data`` at ERROR
    where the other three use DEBUG. Preserved rather than normalised because
    changing a production vendor's log level is a behaviour change, not a
    refactor; nothing here endorses the divergence.

    ``on_turn_finally`` — extra teardown, awaited inside the turn's ``finally``
    AFTER ``unregister_prompt_worker`` and BEFORE ``end_headless_turn``. Claude
    uses it to strip a materialised ``fork_session_id``.
    """
    from flow_sdk.builtin.agentic_process.agentic_process import (  # noqa: PLC0415
        register_prompt_task,
        register_prompt_worker,
        unregister_prompt_worker,
    )

    log_prefix = f"{type(driver).__name__}.headless_prompt"

    register_prompt_worker(process.id, worker)
    # See the module docstring: from here until create_task, this frame owns the
    # slot. Every exit path below must release it.
    try:
        # Create the tee up front so `tail_status` reports INITIALIZING rather
        # than nothing before the first event lands. Workers without a tee
        # (claude) answer None and fall through.
        try:
            transcript_path = worker.transcript_path
            if transcript_path is not None and not transcript_path.exists():
                transcript_path.parent.mkdir(parents=True, exist_ok=True)
                transcript_path.touch()
        except OSError:
            logger.debug("%s: transcript pre-touch failed", log_prefix, exc_info=True)

        if save_running_status:
            from flow_sdk.builtin.process_lifecycle import ProcessStatus  # noqa: PLC0415

            if process.status != ProcessStatus.RUNNING.value:
                process.status = ProcessStatus.RUNNING.value
                try:
                    await process.save()
                except Exception:
                    logger.debug("%s: lifecycle save failed", log_prefix, exc_info=True)

        # Multi-turn correctness: see AgenticProcess._discover_status_from_transcript.
        # Flip the projection to RUNNING for the duration of this turn and
        # broadcast it now so the closing notify_updated (which carries the
        # JSONL-derived COMPLETE) is a real edge for SDK mirrors.
        object.__setattr__(process, "_turn_in_flight", True)
        try:
            await process.notify_updated()
        except Exception:
            logger.exception("%s: start-of-turn notify_updated failed", log_prefix)

        # Session adoption (and its restart-snapshot bookkeeping) is owned by
        # AgenticProcess.adopt_worker_session; the turn-scoped adopter trusts
        # only the turn-initial report (spurious-rotation guard).
        adopt_session = process.make_turn_session_adopter(log_prefix)

        async def _run_turn() -> None:
            try:
                async for fd in worker.execute(prompt=prompt, context=context):
                    await adopt_session(worker.get_session_id())
                    try:
                        await process.emit_flow_data(fd.model_dump())
                    except Exception:
                        logger.log(
                            emit_failure_level,
                            "%s: emit_flow_data failed",
                            log_prefix,
                            exc_info=True,
                        )
            except WorkerSpawnError as e:
                # No subprocess ever started — end the process FAILED with the
                # start_failure latch (the ERROR frame was already emitted).
                await latch_spawn_failure(process, e)
            except Exception:
                logger.exception("%s: worker error", log_prefix)
            finally:
                unregister_prompt_worker(process.id, worker)
                if on_turn_finally is not None:
                    try:
                        await on_turn_finally()
                    except Exception:
                        logger.debug("%s: turn teardown failed", log_prefix, exc_info=True)
                # Terminal status broadcast + completion-driven queue advance
                # (see AgenticProcess.end_headless_turn).
                await process.end_headless_turn(log_prefix)

        task = asyncio.create_task(_run_turn(), name=f"{driver.name}-{process.id[:8]}")
        register_prompt_task(process.id, task)
    except BaseException:
        # _run_turn never took ownership of the slot — release it here so the
        # next turn is not permanently rejected with a 409.
        unregister_prompt_worker(process.id, worker)
        raise
    return ApiSuccessResponse(data={"status": "started", "worker": driver.name})
