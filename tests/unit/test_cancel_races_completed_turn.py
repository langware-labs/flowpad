"""Stop clicked as a turn finishes must not brand that turn interrupted.

The cancel path has a race with its own subject: a worker stays registered
until its stream fully drains, so ``close_session`` can arrive AFTER the CLI
has already exited on its own. Whether that is recorded as an abort decides
two visible things:

* ``cancelled_gracefully`` gates the flowpad sidecar marker, which replays as
  a terminated-turn STATUS frame on every future history load;
* for the jsonl-tee vendors, ``_interrupted`` additionally injects a synthetic
  ``flowpad.interrupted`` event into the worker's OWN transcript — permanent,
  and visible to anything that reads the vendor file.

codex already made the pre-signal check (``wound_down_cleanly =
process.returncode is not None``); claude and the jsonl-tee vendors did not.
These pin the corrected behaviour for both.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(5)


class _ExitedProc:
    """An asyncio subprocess that has already terminated."""

    returncode = 0
    stdin = None

    async def wait(self) -> int:
        return 0


class _LiveProc:
    """An asyncio subprocess still running."""

    returncode = None
    stdin = None

    async def wait(self) -> int:  # pragma: no cover - never awaited in these tests
        return 0


async def test_claude_close_session_after_natural_exit_is_graceful(tmp_path: Path):
    """An already-exited claude worker wrote its own ending — no abort marker.

    Before the fix the exited process failed the ``returncode is None`` gate,
    fell through to ``_terminate_process()``, and left ``cancelled_gracefully``
    False, so ``cancel-prompt`` wrote a durable marker for a turn that had
    completed normally.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
        ClaudeCLIStreamWorker,
    )

    worker = ClaudeCLIStreamWorker()
    worker._proc = _ExitedProc()  # type: ignore[assignment]
    worker._stdin_open = True

    terminated = False

    async def _fail_terminate() -> None:
        nonlocal terminated
        terminated = True

    worker._terminate_process = _fail_terminate  # type: ignore[assignment]

    await worker.close_session()

    assert worker.cancelled_gracefully is True
    assert terminated is False, "an already-exited process must not be terminated again"


async def test_jsonl_tee_close_session_after_natural_exit_writes_no_synthetic_event(
    tmp_path: Path,
):
    """An already-exited jsonl-tee worker must not be marked interrupted.

    ``_interrupted`` drives ``_terminal_synthetic_event``, so setting it here
    branded a completed turn as interrupted inside the vendor's own transcript.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.jsonl_tee_worker import (
        JsonlTeeStreamWorker,
    )

    worker = JsonlTeeStreamWorker.__new__(JsonlTeeStreamWorker)
    worker._interrupted = False
    worker._proc = _ExitedProc()  # type: ignore[assignment]

    async def _noop_terminate() -> None:
        return None

    worker._terminate_process = _noop_terminate  # type: ignore[assignment]

    await worker.close_session()

    assert worker._interrupted is False
    assert worker.cancelled_gracefully is False


async def test_jsonl_tee_close_session_on_live_process_still_marks_interrupted(
    tmp_path: Path,
):
    """The real cancel is unchanged: a LIVE process was genuinely interrupted."""
    from flow_sdk.builtin.agentic_process.cli_drivers.jsonl_tee_worker import (
        JsonlTeeStreamWorker,
    )

    worker = JsonlTeeStreamWorker.__new__(JsonlTeeStreamWorker)
    worker._interrupted = False
    worker._proc = _LiveProc()  # type: ignore[assignment]

    async def _noop_terminate() -> None:
        return None

    worker._terminate_process = _noop_terminate  # type: ignore[assignment]

    await worker.close_session()

    assert worker._interrupted is True
    assert worker.cancelled_gracefully is True


async def test_jsonl_tee_close_session_before_spawn_marks_interrupted(tmp_path: Path):
    """No process yet (cancel before spawn) stays the conservative case."""
    from flow_sdk.builtin.agentic_process.cli_drivers.jsonl_tee_worker import (
        JsonlTeeStreamWorker,
    )

    worker = JsonlTeeStreamWorker.__new__(JsonlTeeStreamWorker)
    worker._interrupted = False
    worker._proc = None

    async def _noop_terminate() -> None:
        return None

    worker._terminate_process = _noop_terminate  # type: ignore[assignment]

    await worker.close_session()

    assert worker._interrupted is True


async def test_asyncio_marker_present() -> None:
    """Guard: these are async tests; a missing anyio/asyncio mode silently skips."""
    await asyncio.sleep(0)
