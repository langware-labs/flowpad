"""RCA capture: a relaunch must not leave another live worker on its session.

Incident (session c8b083cf, teachpal-zone): a hung claude worker became an
orphan — after a relaunch, ``shell.worker_pid`` no longer pointed at it — and
every subsequent relaunch spawned ``claude --resume <sid>`` straight into the
orphan's live JSONL session lock, stalling forever. The relaunch path
(``exit()`` → ``Shell.terminate_worker`` → ``start_pty``) kills only the
single recorded ``worker_pid``; it never verifies the session is clear of
other worker processes before resuming it.

This test reproduces that state with real processes: a real Flowpad worker on
session S, plus a real second ``claude --resume S`` process the shell row does
not track (exactly what the incident's orphan was). It then drives the real
relaunch and asserts the orphan is dead afterward.

FAILS while the bug is present (the orphan survives the relaunch).
PASSES once the relaunch path sweeps every worker attached to the session id.
"""

import asyncio
import os
import pty as _pty
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import psutil
import pytest

from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.skipif(sys.platform == "win32", reason="unix pty required for the orphan worker"),
]

from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: E402
from flow_sdk.builtin.agentic_process.model_tiers import ModelTier  # noqa: E402
from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: E402
from flow_sdk.builtin.shell import Shell  # noqa: E402


async def _poll(predicate, deadline: float, interval: float = 0.25):
    """Await *predicate* until it returns a truthy value or *deadline* passes."""
    while time.monotonic() < deadline:
        value = await predicate()
        if value:
            return value
        await asyncio.sleep(interval)
    return None


def _find_transcript(session_id: str) -> Path | None:
    """Locate the session JSONL under the (real) ``~/.claude/projects``."""
    root = Path(os.environ["HOME"]) / ".claude" / "projects"
    if not root.is_dir():
        return None
    hits = list(root.glob(f"*/{session_id}.jsonl"))
    return hits[0] if hits else None


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(90)
async def test_relaunch_kills_session_orphan(bootstrapped_client, tmp_path):
    """Relaunching a process must kill EVERY live worker on its session id."""
    cn = await ComputeNode.get_one({"uname": "local"})
    assert cn, "No @local compute node found"

    claude_exe = shutil.which("claude")
    assert claude_exe, "claude CLI not on PATH"

    process = AgenticProcess(
        compute_node_id=f"compute_node-{cn.id}",
        cli_config={"permission_mode": "bypassPermissions", "model": ModelTier.SM.value},
        workdir=str(tmp_path),
        visible=True,
    )
    await process.save([])

    orphan = None
    master = slave = None
    try:
        await process.start_pty()
        process = await AgenticProcess.get_by_id(process.id)
        assert process.shell_id, "start_pty() did not set shell_id"

        deadline = time.monotonic() + 30

        async def _session_ready():
            shell = await Shell.get_by_id(process.shell_id)
            if not shell or not shell.worker_pid:
                return None
            cmd = shell.last_launch_cmd if isinstance(shell.last_launch_cmd, dict) else {}
            sid = cmd.get("session_id")
            return (shell.worker_pid, sid) if sid else None

        ready = await _poll(_session_ready, deadline)
        assert ready, "worker_pid / session_id never recorded on the shell"
        original_worker_pid, session_id = ready

        # Interactive claude only writes the session JSONL once a turn runs;
        # the orphan's ``--resume`` needs it on disk before it can attach to
        # the session. Wait for the TUI input prompt, then drive one real turn.
        from tests.long_tests._pty_helpers import read_pty_stream

        async def _tui_ready():
            return "❯" in read_pty_stream(process.shell_id)

        assert await _poll(_tui_ready, deadline), "claude TUI never became ready"
        await process.prompt("Reply with the single word: ok")

        async def _transcript_ready():
            return _find_transcript(session_id)

        if not await _poll(_transcript_ready, time.monotonic() + 45):
            from tests.long_tests._pty_helpers import read_pty_stream

            try:
                worker_cmdline = psutil.Process(original_worker_pid).cmdline()
            except psutil.Error as exc:
                worker_cmdline = f"<{exc}>"
            pytest.fail(
                f"worker never wrote a transcript for session {session_id}\n"
                f"worker cmdline: {worker_cmdline}\n"
                f"HOME={os.environ['HOME']}\n"
                f"pty tail:\n{read_pty_stream(process.shell_id)[-2000:]}"
            )

        # The incident state: a live worker on this session that the shell row
        # does not track. The real orphan was exactly this — a ``claude
        # --resume <sid>`` process left running after ``worker_pid`` had been
        # overwritten by a relaunch.
        master, slave = _pty.openpty()
        orphan = subprocess.Popen(
            [claude_exe, "--resume", session_id],
            cwd=str(tmp_path),
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        await asyncio.sleep(2.0)
        assert orphan.poll() is None, (
            f"orphan `claude --resume {session_id}` exited prematurely "
            f"(rc={orphan.returncode}) — cannot reproduce the incident state"
        )

        # Relaunch through the real path the incident exercised:
        # exit() → Shell.terminate_worker → start_pty(retry=True).
        exit_result = await process.exit()
        assert not getattr(exit_result, "is_fail", lambda: False)(), f"exit() failed: {exit_result}"
        process = await AgenticProcess.get_by_id(process.id)
        await process.start_pty(retry=True)

        # After a relaunch the session must have exactly one live worker.
        # The orphan is what holds Claude's JSONL session lock — leaving it
        # alive is the incident: every fresh ``--resume`` collides and stalls.
        try:
            orphan_proc = psutil.Process(orphan.pid)
            _gone, alive = await asyncio.to_thread(psutil.wait_procs, [orphan_proc], 5.0)
        except psutil.NoSuchProcess:
            alive = []
        assert not alive, (
            f"orphaned worker pid={orphan.pid} for session {session_id} survived the relaunch — "
            f"the relaunch killed only the recorded worker_pid ({original_worker_pid}) and never "
            f"swept the session for other live workers"
        )
    finally:
        if orphan is not None and orphan.poll() is None:
            try:
                os.killpg(os.getpgid(orphan.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        for fd in (master, slave):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
        try:
            process = await AgenticProcess.get_by_id(process.id) or process
            await process.close()
        except Exception:
            pass
