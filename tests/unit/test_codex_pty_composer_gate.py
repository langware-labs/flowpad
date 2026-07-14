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
import base64
import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import ClaudeDriver
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    pump_composer_ready,
    strip_pty_controls,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex.driver import CodexDriver
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.driver import CopilotDriver
from flow_sdk.builtin.shell import _next_unseen_pty_output
from flow_sdk.compute.providers.desktop.pty_stream_file import PtyStreamFile

FIXTURES = Path(__file__).parent / "fixtures"
TRUST_SCREEN = (FIXTURES / "codex_pty_trust_screen.bin").read_bytes()
COMPOSER_SCREEN = (FIXTURES / "codex_pty_composer.bin").read_bytes()


def _raw_capture(name: str) -> bytes:
    """Decode a sanitized raw PTY slice captured by the failing QA cycle."""
    return base64.b64decode((FIXTURES / name).read_text(encoding="ascii"))


CLAUDE_COMPOSER_CAPTURE = _raw_capture("claude_pty_composer_2_1_207.b64")
COPILOT_TRUST_CAPTURE = _raw_capture("copilot_pty_trust_1_0_70.b64")
COPILOT_COMPOSER_CAPTURE = _raw_capture("copilot_pty_composer_1_0_70.b64")


# ── driver interface symmetry ────────────────────────────────────────────────


def test_composer_patterns_are_driver_traits():
    """All live QA vendors now have grounded composer markers.

    A generic prompt glyph is insufficient because startup interstitials paint
    their own selection cursor.
    """
    assert isinstance(CodexDriver.pty_composer_ready_pattern, re.Pattern)
    assert isinstance(ClaudeDriver.pty_composer_ready_pattern, re.Pattern)
    assert isinstance(CopilotDriver.pty_composer_ready_pattern, re.Pattern)


# ── the codex marker vs the real captures ───────────────────────────────────


def test_codex_pattern_matches_real_composer_frame():
    text = strip_pty_controls(COMPOSER_SCREEN)
    assert CodexDriver.pty_composer_ready_pattern.search(text), (
        "codex composer banner not detected in a real trusted-boot capture"
    )


def test_codex_pattern_rejects_real_trust_interstitial():
    text = strip_pty_controls(TRUST_SCREEN)
    assert "trust" in text  # the capture really is the trust screen
    assert not CodexDriver.pty_composer_ready_pattern.search(text), "trust interstitial must NOT read as composer-ready"


def test_trust_screen_option_cursor_is_not_the_marker():
    """The trust screen paints its own ``›`` selection cursor — a naive
    prompt-glyph marker would false-positive on it."""
    assert "›" in strip_pty_controls(TRUST_SCREEN)


def test_claude_pattern_rejects_precomposer_and_matches_real_raw_frame():
    marker_offset = CLAUDE_COMPOSER_CAPTURE.find(b"Try")
    assert marker_offset > 0
    assert not ClaudeDriver.pty_composer_ready_pattern.search(
        strip_pty_controls(CLAUDE_COMPOSER_CAPTURE[:marker_offset])
    )
    assert ClaudeDriver.pty_composer_ready_pattern.search(
        strip_pty_controls(CLAUDE_COMPOSER_CAPTURE)
    )


def test_copilot_composer_pattern_rejects_trust_and_matches_composer():
    trust = strip_pty_controls(COPILOT_TRUST_CAPTURE)
    composer = strip_pty_controls(COPILOT_COMPOSER_CAPTURE)
    assert "Confirm folder trust" in trust
    assert not CopilotDriver.pty_composer_ready_pattern.search(trust)
    assert CopilotDriver.pty_composer_ready_pattern.search(composer)


@pytest.mark.parametrize("driver", [ClaudeDriver(), CodexDriver(), CopilotDriver()])
def test_cold_grounded_vendor_launches_blank_then_uses_gated_delivery(driver):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    launch_instruction, needs_typed_delivery = AgenticProcess._cold_pty_delivery_plan(
        driver,
        MARKER,
    )

    assert launch_instruction is None
    assert needs_typed_delivery is True


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
async def test_pump_not_ready_when_pty_closes_on_blocking_screen():
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


async def test_generation_scoped_history_ignores_old_composer_marker(tmp_path):
    stream = PtyStreamFile(tmp_path / "recovered.pty")
    stream.write(COMPOSER_SCREEN, seq=1)
    stream.write(TRUST_SCREEN, seq=2)
    next_chunk, consumed = _chunk_feed([COMPOSER_SCREEN])

    ready = await pump_composer_ready(
        CodexDriver.pty_composer_ready_pattern,
        stream.read_output_after_seq(1),
        next_chunk,
    )

    assert ready is True
    assert consumed == [True], "stale composer history must not satisfy the recovered PTY"


async def test_snapshot_overlap_discards_duplicate_sequenced_chunk():
    """A paint persisted during subscribe-then-snapshot is present in both
    sources; only the newer queued paint may be appended to snapshot bytes."""
    q: asyncio.Queue = asyncio.Queue()
    await q.put((8, b"already in snapshot"))
    await q.put((9, b"new paint"))

    assert await _next_unseen_pty_output(q, snapshot_max_seq=8) == b"new paint"


# ── AgenticProcess wiring: first typed submission is gated ──────────────────


class _FakeShell:
    """Composer-gated fake PTY shell. ``release_composer`` unblocks the gate."""

    def __init__(self):
        self._composer = asyncio.Event()
        self.gate_result = True
        self.submitted: list[str] = []
        self.write_modes: list[str] = []

    def release_composer(self):
        self._composer.set()

    async def wait_for_composer_ready(self, pattern) -> bool:
        assert isinstance(pattern, re.Pattern)
        await self._composer.wait()
        return self.gate_result

    async def write_then_submit(self, text: str) -> None:
        self.submitted.append(text)
        self.write_modes.append("discrete-enter")

    async def write(self, text: str) -> None:
        self.submitted.append(text)
        self.write_modes.append("paste-with-enter")


def _fake_process(shell, *, driver=None):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    async def _shell():
        return shell

    fake = SimpleNamespace(
        id="proc-c09b",
        driver=driver or CodexDriver(),
        shell=_shell,
    )
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


async def test_claude_gated_delivery_uses_its_paste_submit_contract():
    shell = _FakeShell()
    shell.release_composer()
    proc = _fake_process(shell, driver=ClaudeDriver())

    ok = await proc._typed_pty_delivery(MARKER, landed=asyncio.Event())

    assert ok is True
    assert shell.submitted == [MARKER]
    assert shell.write_modes == ["paste-with-enter"]


# ── PTY turn completion: correlate terminal events and submission ───────────


def _codex_system_entry(subtype: str, turn_id: str | None):
    from flow_sdk.transcript_analyzer.entries.system import SystemEntry

    return SystemEntry(
        id=f"entry-{subtype}",
        session_id="session-c09b",
        timestamp="2026-07-14T00:00:00.000Z",
        worker="codex",
        subtype=subtype,
        payload={"turn_id": turn_id} if turn_id is not None else {},
    )


def _system_entry(subtype: str, *, sidechain: bool = False):
    from flow_sdk.transcript_analyzer.entries.system import SystemEntry

    return SystemEntry(
        id=f"entry-{subtype}",
        session_id="session-c09b",
        timestamp="2026-07-14T00:00:00.000Z",
        worker="test",
        subtype=subtype,
        payload={},
        is_sidechain=sidechain,
    )


def test_matching_codex_task_complete_closes_a_landed_turn():
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    entry = _codex_system_entry("event_msg.task_complete", "turn-current")

    assert AgenticProcess._pty_turn_complete(
        entry,
        worker_type="codex",
        active_turn_id="turn-current",
        user_turn_landed=True,
    )


def test_bare_codex_task_complete_closes_the_active_turn():
    """Codex often omits ``turn_id`` from ``task_complete`` — a bare marker still
    completes the active turn instead of waiting out the inactivity fallback."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    entry = _codex_system_entry("event_msg.task_complete", None)  # payload {} — no turn_id

    assert AgenticProcess._pty_turn_complete(
        entry,
        worker_type="codex",
        active_turn_id="turn-current",
        user_turn_landed=True,
    )


@pytest.mark.parametrize(
    ("worker_type", "subtype"),
    [
        ("claude", "turn_duration"),
        ("copilot", "assistant.turn_end"),
    ],
)
def test_provider_terminal_marker_closes_a_landed_turn(worker_type, subtype):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    assert AgenticProcess._pty_turn_complete(
        _system_entry(subtype),
        worker_type=worker_type,
        active_turn_id=None,
        user_turn_landed=True,
    )


@pytest.mark.parametrize(
    ("entry", "worker_type", "active_turn_id", "user_turn_landed"),
    [
        (
            _codex_system_entry("event_msg.task_complete", "turn-stale"),
            "codex",
            "turn-current",
            True,
        ),
        (
            _codex_system_entry("event_msg.task_complete", "turn-current"),
            "codex",
            "turn-current",
            False,
        ),
        (_codex_system_entry("event_msg.task_complete", "turn-current"), "codex", None, True),
        (
            _codex_system_entry("event_msg.task_started", "turn-current"),
            "codex",
            "turn-current",
            True,
        ),
        (
            _codex_system_entry("event_msg.task_complete", "turn-current"),
            "claude",
            "turn-current",
            True,
        ),
        (
            _codex_system_entry("event_msg.task_complete", "turn-current"),
            "copilot",
            "turn-current",
            True,
        ),
    ],
)
def test_codex_task_complete_rejects_unowned_or_incomplete_terminal_events(
    entry, worker_type, active_turn_id, user_turn_landed
):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    assert not AgenticProcess._pty_turn_complete(
        entry,
        worker_type=worker_type,
        active_turn_id=active_turn_id,
        user_turn_landed=user_turn_landed,
    )


@pytest.mark.parametrize(
    ("entry", "worker_type", "user_turn_landed"),
    [
        (_system_entry("turn_duration"), "claude", False),
        (_system_entry("assistant.turn_end"), "copilot", False),
        (_system_entry("assistant.turn_end"), "claude", True),
        (_system_entry("turn_duration"), "copilot", True),
        (_system_entry("turn_duration", sidechain=True), "claude", True),
        (_system_entry("assistant.turn_end", sidechain=True), "copilot", True),
    ],
)
def test_provider_terminal_marker_rejects_wrong_turn_or_provider(
    entry, worker_type, user_turn_landed
):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    assert not AgenticProcess._pty_turn_complete(
        entry,
        worker_type=worker_type,
        active_turn_id=None,
        user_turn_landed=user_turn_landed,
    )


def test_inactivity_before_user_turn_lands_is_an_error_result():
    """A blocked composer cannot manufacture a successful prompt turn."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    result = AgenticProcess._pty_inactivity_result(False)

    assert result.attributes["element-type"] == "result"
    assert result.attributes["outcome"] == "error"
    assert result.attributes["subtype"] == "submission-error"
    assert result.flow_value == {
        "subtype": "submission-error",
        "reason": "user-turn-not-landed",
    }


def test_inactivity_after_user_turn_lands_preserves_success_result():
    """A real transcript user row keeps the existing PTY completion contract."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    result = AgenticProcess._pty_inactivity_result(True)

    assert result.attributes["element-type"] == "result"
    assert result.attributes["outcome"] == "success"
    assert result.attributes["subtype"] == "success"
    assert result.flow_value == {
        "subtype": "success",
        "reason": "transcript-inactivity",
    }


# ── LAST-RESORT blind delivery: composer marker never matches (regex drift) ──


class _HangShell:
    """Composer-gated fake whose marker NEVER matches — ``wait_for_composer_ready``
    blocks forever (regex drift, or an unrecognized interstitial owns the
    screen). Its blind write lands a real user row in the transcript so the
    poll loop can observe submission.
    """

    def __init__(self, transcript_path: Path, session_id: str):
        self.transcript_path = transcript_path
        self.session_id = session_id
        self.submitted: list[str] = []

    async def wait_for_composer_ready(self, pattern) -> bool:
        assert isinstance(pattern, re.Pattern)
        await asyncio.Event().wait()  # marker never appears — gate hangs
        return False  # pragma: no cover - unreachable

    async def write(self, text: str) -> None:
        self.submitted.append(text)
        self._land_user_row(text)

    async def write_then_submit(self, text: str) -> None:  # pragma: no cover - claude uses write()
        self.submitted.append(text)
        self._land_user_row(text)

    def _land_user_row(self, text: str) -> None:
        line = json.dumps(
            {
                "type": "user",
                "message": {"role": "user", "content": [{"type": "text", "text": text}]},
                "uuid": "22222222-2222-4222-8222-222222222222",
                "sessionId": self.session_id,
                "timestamp": "2026-07-14T00:00:00.000Z",
            }
        )
        with open(self.transcript_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")


class _NeverReadyDriver:
    """Composer-gated claude-shaped driver whose readiness marker never matches."""

    name = "claude"
    pty_composer_ready_pattern = re.compile(r"THIS_MARKER_NEVER_APPEARS_IN_OUTPUT")
    pty_submits_on_paste = True  # claude contract: single paste-with-Enter write

    def transcript_descriptor(self, proc):
        raise NotImplementedError  # force the transcript_path fallback

    def transcript_path(self, proc):
        return proc._transcript_path


@pytest.mark.timeout(5)
async def test_blind_last_resort_when_composer_marker_never_matches(tmp_path):
    """The cold-PTY dead-end fix: when the composer marker never matches, the
    gated delivery hangs and the turn would previously die as submission-error
    with the prompt NEVER typed. The last-resort path types the prompt ONCE
    blindly at the inactivity boundary; when the user row then lands, the turn
    resolves as success — no submission-error."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    session_id = "sess-blind"
    transcript = tmp_path / f"{session_id}.jsonl"
    transcript.write_text("")  # exists, empty → watermark 0

    shell = _HangShell(transcript, session_id)

    async def _shell():
        return shell

    inactivity_landed: list[bool] = []
    real_inactivity = AgenticProcess._pty_inactivity_result

    def _spy_inactivity(landed):
        inactivity_landed.append(landed)
        return real_inactivity(landed)

    fake = SimpleNamespace(
        id="proc-blind",
        driver=_NeverReadyDriver(),
        session_id=session_id,
        shell=_shell,
        _transcript_path=transcript,
    )
    fake._typed_pty_delivery = AgenticProcess._typed_pty_delivery.__get__(fake)
    fake._cold_pty_delivery_plan = AgenticProcess._cold_pty_delivery_plan
    fake._pty_turn_complete = AgenticProcess._pty_turn_complete
    fake._pty_inactivity_result = _spy_inactivity

    sent: list[bytes] = []

    async def _send(data: bytes):
        sent.append(data)

    async def _is_running():
        return True  # hot composer-gated path → needs_initial_type, no start_pty

    async def _persist(_desc):
        return None

    async def _notify():
        return None

    fake.send = _send
    fake.is_running = _is_running
    fake._persist_transcript_session_id = _persist
    fake.notify_updated = _notify

    resp = AgenticProcess._run_pty_prompt.__get__(fake)(MARKER, inactivity_timeout=0.4)
    async for _chunk in resp.body_iterator:
        pass

    # Prompt was typed exactly once, blindly (marker never matched).
    assert shell.submitted == [MARKER]
    # The user row landed after the blind delivery → success, never a
    # submission-error (no _pty_inactivity_result(False) call).
    assert inactivity_landed, "expected a terminal inactivity result"
    assert False not in inactivity_landed
    assert inactivity_landed[-1] is True
