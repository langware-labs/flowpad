"""Shared transcript plumbing for CLI-spawning long tests.

One home for the idioms every "spawn a real worker, assert on its transcript"
test needs (imported like ``tests.long_tests._pty_helpers``):

  * ``assert_prompt_ok`` — ``prompt()`` returns an ApiResponse envelope; a
    FAIL body carries no ``ok`` attr, so ``getattr(result, "ok", True)`` can
    NOT catch it (that idiom silently degraded tests into permanent skips).
  * ``resolve_transcript`` — path-free transcript load: the driver's own
    resolver first, then the analyzer's session resolver (which reads
    ``Path.home()`` live and so survives the conftest HOME swap).
  * ``await_transcript`` — predicate poll with the stale-snapshot fix: the
    worker mutates the DB row through its own entity copy, so the caller's
    ``process`` snapshot goes stale (``status`` stays ``new``, ``session_id``
    stays None) — re-fetch by id each round.
  * ``safe_exit`` — best-effort teardown.
"""

from __future__ import annotations

import asyncio
import time

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.transcript_analyzer import AgentTranscriptFile
from flow_sdk.transcript_analyzer.resolver import (
    TranscriptNotFoundError,
    resolve_session_jsonl,
)

# Analyzer/resolver worker key per WorkerType (the analyzer speaks "claude",
# not "claude_code").
ANALYZER_WORKER_KEY = {
    WorkerType.CLAUDE_CODE: "claude",
    WorkerType.CODEX: "codex",
    WorkerType.COPILOT: "copilot",
}


def assert_prompt_ok(result) -> None:
    assert getattr(result, "status", "SUCCESS") != "FAIL", f"prompt failed: {result}"


def resolve_transcript(process, worker_key: str) -> AgentTranscriptFile | None:
    """Path-free transcript load for ``process`` (worker key per the analyzer)."""
    tf = process._load_transcript()
    if tf is not None:
        return tf
    session_id = process.session_id
    if not session_id:
        return None
    try:
        path = resolve_session_jsonl(worker_key, session_id)
    except (TranscriptNotFoundError, ValueError):
        return None
    if path and path.exists():
        return AgentTranscriptFile(worker_key, path)
    return None


async def await_transcript(process, worker_key: str, predicate, deadline_s: float):
    """Poll (2s cadence) until the transcript satisfies ``predicate``.

    Re-fetches the process entity by id each round (the local snapshot goes
    stale while the worker runs). Returns the last transcript seen — possibly
    not satisfying — or None when none ever appeared."""
    deadline = time.monotonic() + deadline_s
    last: AgentTranscriptFile | None = None
    while time.monotonic() < deadline:
        fresh = await AgenticProcess.get_by_id(process.id) or process
        tf = resolve_transcript(fresh, worker_key)
        if tf is not None:
            last = tf
            if predicate(tf):
                return tf
        await asyncio.sleep(2.0)
    return last


async def safe_exit(process: AgenticProcess) -> None:
    try:
        await process.exit()
    except Exception:
        pass
