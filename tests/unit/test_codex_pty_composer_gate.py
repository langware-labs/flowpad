"""Cold-PTY composer-ready gate (QA C09b).

A fresh interactive codex PTY can sit on a blocking interstitial (directory
trust prompt, login, migration notice) whose screen is *quiet* — so the old
"output went idle for 150 ms" heuristic happily typed the first prompt into
the interstitial, which ate or truncated it while the process kept reporting
ready/complete. RUNNING/quiet is not a composer-ready signal.

The fix is a vendor-owned readiness *pattern* on the driver
(``WorkerDriver.pty_composer_ready_pattern``) matched against the PTY's
ANSI-stripped output stream. First typed submission is deferred until the
pattern appears; it is event-driven (each PTY paint wakes the scanner) — no
sleeps, no poll budget.

The byte fixtures are REAL codex-cli 0.144.1 PTY captures (raw first-boot
output, terminal-capability handshake answered):

- ``codex_pty_trust_screen.bin`` — cold boot in an untrusted directory: the
  "Do you trust the contents of this directory?" interstitial. NO banner.
- ``codex_pty_composer.bin``    — cold boot in a trusted directory: the
  ``>_ OpenAI Codex (v…)`` banner frame, painted together with the composer
  input line. The banner never renders before trust is resolved, so it is the
  composer-ready marker.
"""

import asyncio
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    pump_composer_ready,
    strip_pty_controls,
)
from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import ClaudeDriver
from flow_sdk.builtin.agentic_process.cli_drivers.codex.driver import CodexDriver
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.driver import CopilotDriver

FIXTURES = Path(__file__).parent / "fixtures"
TRUST_SCREEN = (FIXTURES / "codex_pty_trust_screen.bin").read_bytes()
COMPOSER_SCREEN = (FIXTURES / "codex_pty_composer.bin").read_bytes()


# ── driver interface symmetry ────────────────────────────────────────────────


def test_composer_pattern_is_a_driver_trait():
    """Every vendor driver declares the trait; only codex has a grounded marker.

    - claude: cold boot delivers the prompt as a launch arg (pre-filled input,
      Enter-only nudge confirmed via the transcript) — no typed injection to
      protect, so no pattern.
    - copilot: no empirically-grounded marker yet → None keeps the legacy
      settle-then-type behaviour.
    """
    assert isinstance(CodexDriver.pty_composer_ready_pattern, re.Pattern)
    assert ClaudeDriver.pty_composer_ready_pattern is None
    assert CopilotDriver.pty_composer_ready_pattern is None


# ── the codex marker vs the real captures ───────────────────────────────────


def test_codex_pattern_matches_real_composer_frame():
    text = strip_pty_controls(COMPOSER_SCREEN)
    assert CodexDriver.pty_composer_ready_pattern.search(text), (
        "codex composer banner not detected in a real trusted-boot capture"
    )


def test_codex_pattern_rejects_real_trust_interstitial():
    text = strip_pty_controls(TRUST_SCREEN)
    assert "trust" in text  # the capture really is the trust screen
    assert not CodexDriver.pty_composer_ready_pattern.search(text), (
        "trust interstitial must NOT read as composer-ready"
    )


def test_trust_screen_option_cursor_is_not_the_marker():
    """The trust screen paints its own ``›`` selection cursor — a naive
    prompt-glyph marker would false-positive on it."""
    assert "›" in strip_pty_controls(TRUST_SCREEN)


# ── pump_composer_ready: event-driven deferral over the PTY stream ──────────


def _chunk_feed(chunks):
    """Return (next_chunk, consumed) — consumed[i] flips True when chunk i is
    handed to the pump. The feed blocks forever after the list is exhausted
    (like a live PTY at rest) unless the last element is None (close)."""
    consumed = [False] * len(chunks)
    idx = 0

    async def next_chunk():
        nonlocal idx
        if idx >= len(chunks):
            await asyncio.Event().wait()  # PTY at rest — no more paints
        chunk = chunks[idx]
        consumed[idx] = True
        idx += 1
        return chunk

    return next_chunk, consumed


@pytest.mark.timeout(5)
async def test_pump_defers_until_composer_frame():
    """Interstitial first, composer later: the pump must NOT report ready on
    the interstitial and must return True only after consuming the composer
    frame."""
    pattern = CodexDriver.pty_composer_ready_pattern
    next_chunk, consumed = _chunk_feed([TRUST_SCREEN, COMPOSER_SCREEN])

    ready = await pump_composer_ready(pattern, b"", next_chunk)

    assert ready is True
    assert consumed == [True, True], "composer frame must be consumed before ready"


@pytest.mark.timeout(5)
async def test_pump_ready_immediately_from_history():
    """A warm PTY whose accumulated output already shows the composer must
    pass instantly — without waiting for a fresh paint."""
    pattern = CodexDriver.pty_composer_ready_pattern

    async def never_called():  # pragma: no cover - failure mode
        raise AssertionError("must not wait for new output when history matches")

    ready = await pump_composer_ready(pattern, TRUST_SCREEN + COMPOSER_SCREEN, never_called)
    assert ready is True


@pytest.mark.timeout(5)
async def test_pump_not_ready_when_pty_closes_on_interstitial():
    """PTY dies while the interstitial is still up (None close sentinel):
    not ready — the caller must NOT type into a dead/blocked PTY."""
    pattern = CodexDriver.pty_composer_ready_pattern
    next_chunk, _ = _chunk_feed([TRUST_SCREEN, None])

    ready = await pump_composer_ready(pattern, b"", next_chunk)
    assert ready is False


@pytest.mark.timeout(5)
async def test_pump_marker_split_across_paint_chunks():
    """The banner may arrive split across PTY reads; accumulation must still
    detect it."""
    pattern = CodexDriver.pty_composer_ready_pattern
    i = COMPOSER_SCREEN.find(b"OpenAI")
    assert i > 0
    next_chunk, _ = _chunk_feed([COMPOSER_SCREEN[:i], COMPOSER_SCREEN[i:]])

    ready = await pump_composer_ready(pattern, b"", next_chunk)
    assert ready is True


# ── AgenticProcess wiring: first typed submission is gated ──────────────────


class _FakeShell:
    """Composer-gated fake PTY shell. ``release_composer`` unblocks the gate."""

    def __init__(self):
        self._composer = asyncio.Event()
        self.gate_result = True
        self.submitted: list[str] = []

    def release_composer(self):
        self._composer.set()

    async def wait_for_composer_ready(self, pattern) -> bool:
        assert isinstance(pattern, re.Pattern)
        await self._composer.wait()
        return self.gate_result

    async def write_then_submit(self, text: str) -> None:
        self.submitted.append(text)


def _fake_process(shell):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    async def _shell():
        return shell

    fake = SimpleNamespace(id="proc-c09b", driver=CodexDriver(), shell=_shell)
    fake._typed_pty_delivery = AgenticProcess._typed_pty_delivery.__get__(fake)
    return fake


MARKER = "C09B-UNIQUE-MARKER: ✅ multi-byte — must arrive verbatim"


@pytest.mark.timeout(5)
async def test_first_submission_deferred_until_composer_ready():
    """The QA C09b repro at unit level: submission must NOT happen while the
    interstitial is up; once the composer appears, the marker is delivered
    intact (verbatim, single write)."""
    shell = _FakeShell()
    proc = _fake_process(shell)
    landed = asyncio.Event()

    task = asyncio.create_task(proc._typed_pty_delivery(MARKER, landed=landed))
    await asyncio.sleep(0)  # let the delivery task reach the gate
    assert shell.submitted == [], "prompt typed while the interstitial was still up"

    shell.release_composer()
    assert await task is True
    assert shell.submitted == [MARKER], "marker must be delivered intact, exactly once"


@pytest.mark.timeout(5)
async def test_no_submission_when_composer_never_appears():
    """PTY closed while blocked on the interstitial → nothing is typed and the
    caller learns the PTY is unusable (no fake-green submission)."""
    shell = _FakeShell()
    shell.gate_result = False  # pump saw the close sentinel, never the composer
    shell.release_composer()
    proc = _fake_process(shell)

    ok = await proc._typed_pty_delivery(MARKER, landed=asyncio.Event())
    assert ok is False
    assert shell.submitted == []


@pytest.mark.timeout(5)
async def test_no_double_delivery_when_turn_already_landed():
    """If the user turn landed while we waited (e.g. the queue-launch path
    already injected it), the gated delivery must not type a duplicate."""
    shell = _FakeShell()
    shell.release_composer()
    proc = _fake_process(shell)
    landed = asyncio.Event()
    landed.set()

    ok = await proc._typed_pty_delivery(MARKER, landed=landed)
    assert ok is True
    assert shell.submitted == []
