"""A PTY paint is turn activity — FLOWPAD-2034, at unit speed.

The PTY turn-poller used to treat transcript silence as "the turn finished".
But a vendor writes an assistant message to its JSONL only once that message is
COMPLETE, so the file is untouched for the whole time the model is thinking,
generating, or running a tool: silence is the normal state of a WORKING agent,
not a turn boundary. Any turn whose quiet stretch outlasted the inactivity
fallback had its stream closed mid-flight — and was still reported successful.

The fix reads the session's ``.pty`` stream file: the vendor TUI paints
continuously while it works, so a change there means the worker is still busy
and ``last_activity`` is refreshed from it.

These tests drive the REAL ``_run_pty_prompt`` poller. Only the things that
would need a machine — the driver, the PTY writes, the shell lookup — are
stubbed; the transcript, the stream file, the clock and the loop itself are
real. The transcript deliberately never changes, which is exactly the
condition the bug needed: with the fix, the painted stream file alone must
hold the turn open.

``inactivity_timeout`` is an existing parameter of ``_run_pty_prompt`` and is
SHORTENED here (not raised) purely to isolate the rule under test — the
production default of 15.0s is untouched. CLAUDE.md forbids widening a wait to
ride past a symptom; narrowing one in a test makes the assertion strictly
stricter, and it is what keeps this file inside the suite's 30s cap.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess

#: Short enough to keep the whole file well inside pytest.ini's --timeout=30,
#: long enough that a 0.3s poll tick cannot straddle it.
INACTIVITY = 1.0
#: How long the fake TUI keeps painting. Several times INACTIVITY, so a poller
#: that ignores the paint has no way to look merely slow.
PAINT_FOR = 3.0
PAINT_EVERY = 0.15


class _StubDriver:
    """The vendor traits ``_run_pty_prompt`` reads, and nothing else.

    ``pty_submits_on_paste`` + no composer pattern is the simplest delivery
    path: one ``send()``, no composer gate, no blind-delivery branch — so the
    test exercises the POLL loop rather than the delivery ladder.
    """

    name = "claude"
    pty_submits_on_paste = True
    pty_composer_ready_pattern = None

    def __init__(self, transcript: Path) -> None:
        self._transcript = transcript

    def transcript_descriptor(self, _process):
        return SimpleNamespace(path=self._transcript, format=None, derived=False, session_id=None)

    def transcript_path(self, _process):
        return self._transcript


@pytest.fixture
def pty_turn(tmp_path, monkeypatch):
    """A process whose turn can be driven with no machine attached.

    Returns ``(process, stream_path, run)`` where ``run`` consumes one real
    prompt stream and reports when its terminal frame arrived.
    """
    transcript = tmp_path / "session.jsonl"
    transcript.write_bytes(b"")  # exists, parses to zero entries, never grows
    stream_path = tmp_path / "session.pty"

    process = AgenticProcess(id=mint_uuid(), pty_mode=True, shell_id=str(mint_uuid()))
    driver = _StubDriver(transcript)
    monkeypatch.setattr(AgenticProcess, "driver", property(lambda _self: driver))

    async def _true(*_a, **_k):
        return True

    async def _noop(*_a, **_k):
        return None

    # The PTY is "already live", so delivery is a single send() we swallow —
    # nothing here is the subject of the test.
    monkeypatch.setattr(AgenticProcess, "is_running", _true)
    monkeypatch.setattr(AgenticProcess, "send", _noop)
    monkeypatch.setattr(AgenticProcess, "_persist_transcript_session_id", _noop)
    monkeypatch.setattr(AgenticProcess, "notify_updated", _noop)

    # ``_pty_change_signature`` imports these at CALL time, so patching the
    # module attributes is enough to point it at our stream file.
    monkeypatch.setattr(
        "flow_sdk.builtin.shell.get_shell_record",
        lambda _sid: SimpleNamespace(id="shell", pty_pid=None),
        raising=False,
    )
    monkeypatch.setattr(
        "flow_sdk.builtin.shell.shell_pty_stream_path",
        lambda _id, _pid: stream_path,
        raising=False,
    )

    async def run(paint_for: float, budget: float) -> float | None:
        """Drive one turn, painting for ``paint_for`` seconds.

        Returns seconds from turn start until the terminal ``flow-result``
        frame arrived, or ``None`` if the stream was still open at ``budget``.
        """
        started = time.monotonic()
        closed_at: float | None = None

        async def _paint() -> None:
            while time.monotonic() - started < paint_for:
                # Append, mirroring how the real TUI grows its stream file.
                with open(stream_path, "ab") as fh:
                    fh.write(b"paint\n")
                    fh.flush()
                await asyncio.sleep(PAINT_EVERY)

        response = process._run_pty_prompt("hello", inactivity_timeout=INACTIVITY)
        painter = asyncio.create_task(_paint())

        async def _consume() -> float:
            body = b""
            async for chunk in response.body_iterator:
                body += chunk if isinstance(chunk, bytes) else chunk.encode()
                if b"<flow-result" in body:
                    return time.monotonic() - started
            return time.monotonic() - started

        consumer = asyncio.create_task(_consume())
        try:
            closed_at = await asyncio.wait_for(asyncio.shield(consumer), timeout=budget)
        except asyncio.TimeoutError:
            closed_at = None
        finally:
            painter.cancel()
            consumer.cancel()
            for task in (painter, consumer):
                try:
                    await task
                except BaseException:
                    pass
            # Close the generator explicitly. Cancelling the consumer leaves the
            # body iterator's athrow pending, which asyncio reports at GC time as
            # a stray "Task was destroyed but it is pending" against whatever test
            # happens to be running next.
            try:
                await response.body_iterator.aclose()
            except BaseException:
                pass
        return closed_at

    return process, stream_path, run


@pytest.mark.asyncio
async def test_a_painting_pty_holds_the_turn_open_past_the_inactivity_window(pty_turn):
    """The bug, directly: a silent transcript must not end a working turn.

    The transcript never changes for the whole run, so transcript-only liveness
    would close the stream one ``INACTIVITY`` after the turn starts. The stream
    file is painted throughout, which is the worker saying it is still busy.
    """
    _process, _stream, run = pty_turn

    closed_at = await run(paint_for=PAINT_FOR, budget=PAINT_FOR * 0.8)

    assert closed_at is None, (
        f"the turn was cut off after {closed_at:.1f}s while the PTY was still painting — "
        f"transcript silence was treated as a turn boundary (FLOWPAD-2034)"
    )


@pytest.mark.asyncio
async def test_the_turn_still_ends_once_the_pty_goes_quiet(pty_turn):
    """The fallback is delayed by a paint, never disabled by one.

    Counterpart to the test above: without this, "hold the turn open" could be
    satisfied by a poller that simply never closes.
    """
    _process, _stream, run = pty_turn

    closed_at = await run(paint_for=INACTIVITY, budget=INACTIVITY * 6)

    assert closed_at is not None, "the turn never ended after the PTY stopped painting"
    assert closed_at >= INACTIVITY, (
        f"closed after {closed_at:.1f}s — sooner than the inactivity window itself, so the "
        f"paint was not counted as activity at all"
    )


@pytest.mark.asyncio
async def test_an_unreadable_stream_file_falls_back_to_transcript_liveness(pty_turn, monkeypatch):
    """No shell, no stream file, or a bad stat must not hold the turn open.

    ``_pty_change_signature`` returns ``None`` on any of those, and the poller
    then behaves exactly as it did before the fix. Pins the documented
    degradation so a future change cannot turn a missing signal into a turn
    that never ends.
    """
    _process, _stream, run = pty_turn
    monkeypatch.setattr(
        "flow_sdk.builtin.shell.get_shell_record",
        lambda _sid: None,
        raising=False,
    )

    closed_at = await run(paint_for=PAINT_FOR, budget=INACTIVITY * 5)

    assert closed_at is not None, (
        "with no readable PTY stream the turn must still close on transcript inactivity"
    )
