"""Liveness-gated "has the headless worker started?" wait.

The migration runner and the `flow diagnose` / `flow migrate` commands all spawn a
headless worker, wait for it to start, then stream its transcript. This is the
shared "wait for start" step.

Kept in a dependency-light leaf module (NOT under the heavy
``flow_sdk.builtin.agentic_process`` package) so importing it doesn't drag the
agentic-process machinery into `flow` CLI startup. ``await_worker_started``
imports ``_PROMPT_WORKERS`` lazily (at call time) to preserve that property.
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from flow_sdk.agentic_run_consts import AGENT_WARMUP_INTERVAL_S

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process import AgenticProcess


async def await_worker_started(ap: "AgenticProcess", transcript_timeout: float) -> bool:
    """Block until the headless worker writes its first transcript line, or has
    ended without producing one. Returns ``True`` iff a transcript appeared.

    The driver pre-assigns ``ap.session_id`` eagerly, so a non-empty session id
    is NOT proof the worker started — a transcript file with content is the
    canonical "started" signal. We must NOT gate this on a fixed wall-clock: a
    healthy cold-start (notably the ``claude`` CLI on Windows) can take ~20s+ to
    write its first line, so any short window false-fails a worker that is
    actually fine. Instead, key the fast-fail off worker *liveness*: the driver
    registers the in-flight worker in ``_PROMPT_WORKERS[ap.id]`` and removes it
    the instant its turn ends — success, crash, or never-started (e.g. the CLI
    binary could not be resolved, which makes the worker emit an error frame and
    exit at once). So:

      * transcript appears          → started, return True;
      * worker still registered     → alive but slow, keep waiting;
      * worker gone, no transcript  → it died / never started, return False.

    The outer bound reuses the caller's existing ``transcript_timeout`` budget
    (no new or widened wait) purely to cap the pathological "spawned, never
    wrote, never exited" case rather than hang forever.
    """
    from flow_sdk.builtin.agentic_process.agentic_process import _PROMPT_WORKERS

    def _started() -> bool:
        tp = ap.driver.transcript_path(ap)
        return bool(tp and tp.exists() and tp.stat().st_size > 0)

    loop = asyncio.get_running_loop()
    deadline = loop.time() + transcript_timeout
    while loop.time() < deadline:
        if _started():
            return True
        if ap.id not in _PROMPT_WORKERS:
            # The turn ended. Re-check once to settle the wrote-then-exited race
            # (worker may have written its first line and popped itself between
            # the two checks above).
            return _started()
        await asyncio.sleep(AGENT_WARMUP_INTERVAL_S)
    return _started()
