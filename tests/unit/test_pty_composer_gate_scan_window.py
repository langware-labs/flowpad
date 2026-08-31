"""Composer-readiness must survive a long-lived PTY generation.

``pump_composer_ready`` scans only the trailing ``_COMPOSER_SCAN_WINDOW`` bytes
of the generation's accumulated output. Claude paints the composer-ready marker
(``❯␣───…``) only on a FULL composer redraw — rare in a working session — so
after one long turn the marker sits far behind that window. The gate then has
nothing to match and, since it only ever waits on the next paint, never returns:
every subsequent prompt is stalled until the turn loop's blind last-resort
delivery types it.

Readiness is a property of the PTY GENERATION ("this TUI has booted past its
interstitials"), not of the last 64 KB of screen traffic — it cannot expire
because the terminal has been chatty since.

Readiness also LATCHES per generation (``PtyState.composer_ready_seq``) so a
long session does not re-scan its whole transcript on every prompt. The latch
cannot change the ANSWER — the scan below is generation-scoped and would reach
the same verdict — so what is covered here is that it engages, and that it is
never inherited across a respawn (a composer from the previous process must
not authorize typing into the new one).

No mocks: a real OS PTY, the real captured claude composer frame, the real
``Shell.wait_for_composer_ready`` the turn loop calls (agentic_process.py:3861).
"""

import asyncio
import base64
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import ClaudeDriver
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import strip_pty_controls
from flow_sdk.compute.providers.desktop.pty_session_manager import pty_registry
from tests.unit.conftest import make_shell, py_command, tmp_records_root  # noqa: F401

FIXTURES = Path(__file__).parent / "fixtures"
COMPOSER_FRAME = base64.b64decode((FIXTURES / "claude_pty_resume_composer_2_1_220.b64").read_text("ascii"))
PATTERN = ClaudeDriver.pty_composer_ready_pattern

# A chatty generation: far more post-marker output than any trailing-window
# scan would retain. Deliberately NOT derived from the scan window — the
# scenario is "the session kept talking", not "twice some constant".
FILLER = 128 * 1024


@pytest.fixture(autouse=True)
def _use_tmp_records_root(tmp_records_root):  # noqa: F811
    return tmp_records_root


def _generation_snapshot(shell):
    """The bytes Shell.wait_for_composer_ready feeds the pump (product path)."""
    provider_id = shell.compute_node.node_provider_id
    session = pty_registry.states[(shell.compute_node_id, provider_id, shell.id)]
    initial, _ = session.pty_stream_file.read_output_snapshot_after_seq(session.generation_start_seq)
    return initial


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.composer_readiness.rules: FAILING? the composer-ready gate went
#       blind because the vendor's marker fell outside the scanned slice - read this
#       tag's rules before touching pump_composer_ready or _COMPOSER_SCAN_WINDOW
# flowpad:endcapsule tag
@pytest.mark.asyncio
async def test_composer_ready_survives_a_chatty_generation():
    """A booted composer stays ready after >64 KB of later output."""
    marker_b64 = base64.b64encode(COMPOSER_FRAME).decode()
    emit_marker = py_command(
        f"import sys,base64;sys.stdout.buffer.write(base64.b64decode('{marker_b64}'));sys.stdout.buffer.flush()"
    )
    emit_filler = py_command(f"import sys;sys.stdout.buffer.write(b'x'*{FILLER});sys.stdout.buffer.flush()")
    shell = make_shell()
    try:
        await shell.start()
        # A real terminal: the composer frame is painted once, then the session
        # stays busy and pushes it far behind the trailing scan window.
        await shell.write(emit_marker)
        for _ in range(200):
            if PATTERN.search(strip_pty_controls(_generation_snapshot(shell))):
                break
            await asyncio.sleep(0.1)
        marked = len(_generation_snapshot(shell))
        await shell.write(emit_filler)

        for _ in range(300):
            if len(_generation_snapshot(shell)) - marked > FILLER:
                break
            await asyncio.sleep(0.1)

        snap = _generation_snapshot(shell)
        assert PATTERN.search(strip_pty_controls(snap)), "marker must be in this generation"
        assert len(snap) - marked > FILLER, "scenario: the session kept talking after the marker"

        # The product call. Bounded only so a non-returning gate surfaces as a
        # failure instead of hanging the suite — never widened to make it pass.
        ready = await asyncio.wait_for(shell.wait_for_composer_ready(PATTERN), 5.0)
        assert ready is True, "a booted composer must still gate as ready"
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


def _session(shell):
    provider_id = shell.compute_node.node_provider_id
    return pty_registry.states[(shell.compute_node_id, provider_id, shell.id)]


@pytest.mark.asyncio
async def test_confirmed_readiness_latches_for_this_generation():
    """The gate records its verdict so later prompts skip the scan."""
    emit_marker = py_command(
        "import sys,base64;sys.stdout.buffer.write(base64.b64decode("
        f"'{base64.b64encode(COMPOSER_FRAME).decode()}'));sys.stdout.buffer.flush()"
    )
    shell = make_shell()
    try:
        await shell.start()
        session = _session(shell)
        assert session.composer_ready_seq is None, "nothing confirmed before the composer paints"

        await shell.write(emit_marker)
        for _ in range(200):
            if PATTERN.search(strip_pty_controls(_generation_snapshot(shell))):
                break
            await asyncio.sleep(0.1)

        assert await asyncio.wait_for(shell.wait_for_composer_ready(PATTERN), 5.0) is True
        # Latched, and stamped INSIDE this generation — the comparison the gate
        # uses to decide whether the stamp still belongs to the live process.
        assert session.composer_ready_seq is not None
        assert session.composer_ready_seq > session.generation_start_seq

        # A second prompt reuses the verdict rather than re-deriving it.
        assert await asyncio.wait_for(shell.wait_for_composer_ready(PATTERN), 5.0) is True
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


@pytest.mark.asyncio
async def test_readiness_is_never_inherited_across_a_respawn():
    """A respawned PTY proves itself again — QA C09b's whole point.

    Were a stale verdict carried over, the turn loop would type the next prompt
    into whatever the new process is showing, interstitial included.

    Scope, so this is not mistaken for more than it is: every respawn reachable
    from the Shell API builds a FRESH ``PtyState``, so the verdict is gone by
    eviction and the gate's ``> generation_start_seq`` guard never runs here.
    That guard covers a recovery respawn that reuses a live state (the case
    ``generation_start_seq`` itself exists for, pty_actions.py) and is NOT
    exercised by this test — verified by mutation: dropping the comparison
    leaves this green. What is locked here is the user-facing contract.
    """
    emit_marker = py_command(
        "import sys,base64;sys.stdout.buffer.write(base64.b64decode("
        f"'{base64.b64encode(COMPOSER_FRAME).decode()}'));sys.stdout.buffer.flush()"
    )
    shell = make_shell()
    try:
        await shell.start()
        await shell.write(emit_marker)
        for _ in range(200):
            if PATTERN.search(strip_pty_controls(_generation_snapshot(shell))):
                break
            await asyncio.sleep(0.1)
        assert await asyncio.wait_for(shell.wait_for_composer_ready(PATTERN), 5.0) is True

        # Real respawn: the PTY exits, then the shell is reopened.
        pty = shell.compute_node.get_pty(shell.id)
        await pty.kill()
        assert shell.is_alive is False
        await shell.start()
        assert shell.is_alive is True

        # The new generation never painted the marker, so the gate must block
        # rather than answer from the previous process. Bounded only so the
        # hang is observable as a failure.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(shell.wait_for_composer_ready(PATTERN), 3.0)
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
