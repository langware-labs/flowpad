"""Unit tests for Shell I/O + worker-tracking interface (docs/interface/shell.md).

Covers the PTY-I/O and worker-tracking surface not exercised by
``test_shell_proc_interface.py``:

- ``write_then_submit`` — paste-then-separate-Enter (two distinct writes, ordered)
- ``wait_for_input_ready`` — the public prompt gate incl. its timeout branch
- ``worker_alive`` — dead-PTY raise + the cmdline-match branch (both outcomes)
- ``set_worker_pid_direct`` — the direct-spawn (shell_mode=False) path
- legacy ``launch`` / shell_mode=True — ``_poll_for_worker_pid`` child discovery
  and ``last_launch_cmd`` persistence

No mocks of the unit under test. Tests that need a live PTY create a Shell with a
random compute_node_id and call ``start_pty()`` (a real OS PTY). The
``wait_for_input_ready`` tests drive the readiness signal by seeding the process-
local ``pty_registry`` state — a real registry object, no waits extended.
"""

import asyncio
import os
import sys
import uuid

import psutil
import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerCLIOptions
from flow_sdk.builtin.shell import Shell
from flow_sdk.compute.providers.desktop.pty_session_manager import PtyState, pty_registry

from tests.unit.conftest import kill_pty, make_shell, poll_read, tmp_records_root  # noqa: F401


@pytest.fixture(autouse=True)
def _use_tmp_records_root(tmp_records_root):
    """Opt this module into the shared records-root redirect (see conftest)."""
    return tmp_records_root


async def _seed_ready(shell: Shell, seq: int = 5):
    """Make ``_wait_for_shell_ready`` return immediately by giving the shell's
    PtyState a stable positive ``seq`` (output has 'gone idle').

    Mutates the REAL registry state when a live PTY already registered one (the
    write path reads ``session.cols`` off it, so it must stay a genuine
    ``PtyState``); otherwise creates one. Returns ``(key, created)`` — the caller
    pops only what this helper created; a real PTY's state is torn down by
    ``kill()``."""
    await shell.ensure_live_compute_node_binding()
    provider_id = shell.compute_node.node_provider_id
    key = (shell.compute_node_id, provider_id, shell.id)
    existing = pty_registry.states.get(key)
    if existing is not None:
        existing.seq = seq
        return key, False
    pty_registry.states[key] = PtyState(pty_key=key, seq=seq)
    return key, True


class _FakeCLIOptions(WorkerCLIOptions):
    """Concrete cheap-argv options — spawns/labels ``sleep`` instead of a real
    worker CLI. The fake-argv pattern the plan endorses for shell-mode unit
    coverage; it is a real ``WorkerCLIOptions`` subclass, not a mock of Shell."""

    EXECUTABLE = "sleep"

    def __init__(self, seconds: str = "30", **kwargs):
        super().__init__(**kwargs)
        self._seconds = seconds

    def _emit_flags(self):
        return [self._seconds]


# ---------------------------------------------------------------------------
# write_then_submit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_write_then_submit_sends_two_distinct_ordered_writes(monkeypatch):
    """The text and the Enter must reach the PTY as TWO separate writes, text
    first — a trailing ``\\r`` folded into the paste is exactly what breaks the
    rich TUIs this method exists for.

    ``get_pty`` hands back a fresh handle wrapper per call, so the writes are
    captured at the ``LocalPtySession.write`` class seam (filtered to this
    shell), which every wrapper for this session funnels through."""
    import flow_sdk.compute.providers.desktop.local_pty_session as _lps

    shell = make_shell()
    await shell.start()
    key, _created = await _seed_ready(shell)

    writes: list[bytes] = []
    orig_write = _lps.LocalPtySession.write

    async def _spy(self, data):
        if getattr(self, "shell_id", None) == shell.id:
            writes.append(bytes(data))
        return await orig_write(self, data)

    monkeypatch.setattr(_lps.LocalPtySession, "write", _spy)

    try:
        await shell.write_then_submit("echo hi")

        assert writes == [b"echo hi", b"\r"], (
            f"expected [text, Enter] as distinct writes, got {writes!r}"
        )
    finally:
        if _created:
            pty_registry.states.pop(key, None)
        await kill_pty(shell)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_write_then_submit_actually_submits_to_shell():
    """Behavioural check: the discrete Enter submits, so the echoed command runs."""
    shell = make_shell()
    await shell.start()
    key, _created = await _seed_ready(shell)
    try:
        await shell.write_then_submit("echo wts_marker")
        assert b"wts_marker" in await poll_read(shell, b"wts_marker")
    finally:
        if _created:
            pty_registry.states.pop(key, None)
        await kill_pty(shell)


# ---------------------------------------------------------------------------
# wait_for_input_ready
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_wait_for_input_ready_returns_when_prompt_idle():
    """Once output has gone idle (stable seq > 0) the gate returns promptly,
    well before its timeout."""
    shell = make_shell()
    key, _created = await _seed_ready(shell, seq=7)
    try:
        import time
        start = time.monotonic()
        await shell.wait_for_input_ready(timeout=5.0)
        elapsed = time.monotonic() - start
        assert elapsed < 2.0, f"gate should return early on idle output, took {elapsed:.2f}s"
    finally:
        if _created:
            pty_registry.states.pop(key, None)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_wait_for_input_ready_times_out_when_never_ready():
    """With no session state the readiness signal never arrives; the gate must
    fall through to its deadline and return (never raise). The 1.0s here is the
    METHOD's own gate budget being exercised, not a test timeout."""
    shell = make_shell()
    await shell.ensure_live_compute_node_binding()
    provider_id = shell.compute_node.node_provider_id
    key = (shell.compute_node_id, provider_id, shell.id)
    pty_registry.states.pop(key, None)  # ensure the readiness signal is absent

    import time
    start = time.monotonic()
    await shell.wait_for_input_ready(timeout=1.0)
    elapsed = time.monotonic() - start
    assert elapsed >= 0.9, f"gate returned before its deadline ({elapsed:.2f}s)"


# ---------------------------------------------------------------------------
# worker_alive
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(5)  # do not increase timeout without approval
async def test_worker_alive_false_without_worker_pid():
    shell = make_shell()
    assert await shell.worker_alive() is False


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_worker_alive_false_when_pid_gone():
    """A worker_pid that no longer exists → False (no PTY started, so no raise)."""
    shell = make_shell(worker_pid=2_000_000_000, worker_name="claude")
    assert not psutil.pid_exists(shell.worker_pid)
    assert await shell.worker_alive() is False


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_worker_alive_raises_when_pty_dead():
    """A dead PTY under a shell that still has a worker_pid is a hard error —
    worker_alive raises rather than silently reporting a liveness answer."""
    shell = make_shell()
    await shell.start()
    shell.worker_pid = os.getpid()  # a definitely-live pid; the raise precedes the pid check
    shell.worker_name = os.path.basename(sys.executable)

    # OS-kill the PTY process WITHOUT handle.kill() — kill() evicts the session
    # so get_pty() returns None (no raise); a crashed-but-not-reaped PTY is the
    # state worker_alive's raise guards, so the handle must survive as dead.
    cn = shell.compute_node
    pty_pid = cn.compute_provider.get_pty_shell_pid(cn.node_provider_id, shell.id)
    victim = psutil.Process(pty_pid)
    victim.kill()
    await asyncio.to_thread(psutil.wait_procs, [victim], 5)

    try:
        with pytest.raises(RuntimeError, match="PTY session is not alive"):
            await shell.worker_alive()
    finally:
        await kill_pty(shell)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_worker_alive_true_when_cmdline_matches():
    """Live PTY + a live worker_pid whose cmdline basename matches worker_name."""
    shell = make_shell()
    await shell.start()
    proc = await asyncio.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(30)")
    try:
        shell.worker_pid = proc.pid
        shell.worker_name = os.path.basename(sys.executable)
        assert await shell.worker_alive() is True
    finally:
        proc.terminate()
        await proc.wait()
        await kill_pty(shell)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_worker_alive_false_when_cmdline_mismatches():
    """Live PTY + a live worker_pid whose cmdline does NOT match worker_name →
    False (the process is alive but is not our worker)."""
    shell = make_shell()
    await shell.start()
    proc = await asyncio.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(30)")
    try:
        shell.worker_pid = proc.pid
        shell.worker_name = "definitely_not_the_worker_binary"
        assert await shell.worker_alive() is False
    finally:
        proc.terminate()
        await proc.wait()
        await kill_pty(shell)


# ---------------------------------------------------------------------------
# set_worker_pid_direct (shell_mode=False)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_set_worker_pid_direct_reads_pty_pid_immediately():
    """Direct-spawn path: the PTY PID *is* the worker PID, read straight from the
    provider (no child polling). worker_pid/worker_name/last_launch_cmd persist."""
    shell = make_shell()
    await shell.start()
    try:
        cmd = _FakeCLIOptions()
        cn = shell.compute_node
        expected_pid = cn.compute_provider.get_pty_shell_pid(cn.node_provider_id, shell.id)
        assert expected_pid is not None

        info = await shell.set_worker_pid_direct(cmd)

        assert info.pid == expected_pid
        assert info.name == "sleep"
        assert info.cmd is None  # direct-spawn doesn't type a command line
        assert shell.worker_pid == expected_pid
        assert shell.worker_name == "sleep"
        assert shell.last_launch_cmd == cmd.to_json()
    finally:
        await kill_pty(shell)


# ---------------------------------------------------------------------------
# legacy launch / shell_mode=True — _poll_for_worker_pid + last_launch_cmd
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_launch_discovers_worker_child_and_persists_cmd():
    """shell-mode: the command is TYPED into the shell, and the worker child is
    discovered by walking the shell's process tree. worker_pid/name/last_launch_cmd
    are stamped on the entity."""
    shell = make_shell()
    await shell.start()
    key, _created = await _seed_ready(shell)
    try:
        cmd = _FakeCLIOptions(seconds="30")
        info = await shell.launch(cmd)

        assert info.pid is not None, "launch failed to discover the sleep child"
        assert psutil.pid_exists(info.pid)
        assert "sleep" in os.path.basename(psutil.Process(info.pid).cmdline()[0]).lower()
        assert shell.worker_pid == info.pid
        assert shell.worker_name == "sleep"
        assert shell.last_launch_cmd == cmd.to_json()
    finally:
        if _created:
            pty_registry.states.pop(key, None)
        await shell.terminate_worker()
        await kill_pty(shell)


@pytest.mark.asyncio
@pytest.mark.timeout(5)  # do not increase timeout without approval
async def test_poll_for_worker_pid_none_when_no_shell_pid():
    """No shell PID to walk → no child to find, returns None (no polling)."""
    shell = make_shell()
    assert await shell._poll_for_worker_pid(None, "claude") is None
