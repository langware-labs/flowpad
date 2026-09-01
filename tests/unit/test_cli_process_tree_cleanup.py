"""Regression coverage for print-mode CLI subprocess-tree cleanup."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any

import psutil
import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeCLIStreamWorker
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    stamp_cli_run_id,
    terminate_asyncio_process_tree,
    wait_for_asyncio_process_or_kill_tree,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex import CodexCLIStreamWorker
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import CopilotCLIStreamWorker
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.stream_worker import OpenCodeCLIStreamWorker

_SLEEPING_CHILD = """
import os
import signal
import sys
import time
from pathlib import Path

if hasattr(signal, "SIGTERM"):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(sys.argv[1]).write_text(str(os.getpid()), encoding="utf-8")
time.sleep(60)
"""

_PYTHON_WRAPPER = """
import os
import signal
import subprocess
import sys
import time

if hasattr(signal, "SIGTERM"):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
subprocess.Popen(
    [sys.argv[1], "-c", sys.argv[2], sys.argv[3]],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
if len(sys.argv) >= 5:
    while not os.path.exists(sys.argv[4]):
        time.sleep(0.01)
    raise SystemExit(int(sys.argv[5]) if len(sys.argv) > 5 else 0)
else:
    time.sleep(60)
"""

_CLEAN_TERM_WRAPPER = """
import signal
import sys
import time
from pathlib import Path

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
Path(sys.argv[1]).touch()
time.sleep(60)
"""

_PROCESS_GONE = (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess)


def _is_live(process: psutil.Process) -> bool:
    try:
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except _PROCESS_GONE:
        return False


async def _spawn_python_process_tree(
    tmp_path: Path,
    *,
    wrapper_exit_path: Path | None = None,
    wrapper_exit_code: int = 0,
    env: dict[str, str] | None = None,
) -> tuple[asyncio.subprocess.Process, psutil.Process]:
    """Spawn a wrapper and wait until its child has installed SIGTERM handling."""
    child_pid_path = tmp_path / "sleeping-child.pid"
    argv = [
        sys.executable,
        "-c",
        _PYTHON_WRAPPER,
        sys.executable,
        _SLEEPING_CHILD,
        str(child_pid_path),
    ]
    if wrapper_exit_path is not None:
        argv.extend([str(wrapper_exit_path), str(wrapper_exit_code)])
    wrapper = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    deadline = asyncio.get_running_loop().time() + 5
    while asyncio.get_running_loop().time() < deadline:
        try:
            child_pid = int(child_pid_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            if wrapper.returncode is not None:
                assert wrapper.stderr is not None
                stderr = (await wrapper.stderr.read()).decode(errors="replace")
                pytest.fail(f"process-tree wrapper exited before its child was ready: {stderr}")
            await asyncio.sleep(0.01)
            continue
        return wrapper, psutil.Process(child_pid)

    if wrapper.returncode is None:
        wrapper.kill()
        await wrapper.wait()
    pytest.fail("timed out waiting for the process-tree child PID")


async def _wait_until_stopped(process: psutil.Process, timeout: float = 2) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while _is_live(process) and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)


async def _cleanup_process_tree(
    wrapper: asyncio.subprocess.Process,
    child: psutil.Process,
) -> None:
    """Best-effort safety net so a failing assertion cannot leak sleepers."""
    if _is_live(child):
        try:
            child.kill()
        except _PROCESS_GONE:
            pass
        await asyncio.to_thread(psutil.wait_procs, [child], 2)
    if wrapper.returncode is None:
        try:
            wrapper.kill()
        except ProcessLookupError:
            pass
        await wrapper.wait()


@pytest.mark.asyncio
@pytest.mark.timeout(10)
async def test_terminate_asyncio_process_tree_force_kills_wrapper_and_child(tmp_path: Path):
    wrapper, child = await _spawn_python_process_tree(tmp_path)

    try:
        # Both Python processes ignore SIGTERM on POSIX, pinning the escalation
        # path that previously killed only the wrapper and orphaned its child.
        await terminate_asyncio_process_tree(wrapper, grace_seconds=0.1)
        await _wait_until_stopped(child)

        assert wrapper.returncode is not None
        assert not _is_live(child)
    finally:
        await _cleanup_process_tree(wrapper, child)


@pytest.mark.asyncio
@pytest.mark.timeout(10)
async def test_passive_wait_preserves_child_after_clean_wrapper_exit(tmp_path: Path):
    wrapper_exit_path = tmp_path / "let-wrapper-exit"
    wrapper, child = await _spawn_python_process_tree(
        tmp_path,
        wrapper_exit_path=wrapper_exit_path,
    )
    unrelated = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "import time; time.sleep(60)",
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    unrelated_process = psutil.Process(unrelated.pid)

    async def _release_wrapper() -> None:
        # Give the helper time to snapshot descendants before the root exits.
        await asyncio.sleep(0.05)
        wrapper_exit_path.touch()

    release_task = asyncio.create_task(_release_wrapper())
    try:
        await wait_for_asyncio_process_or_kill_tree(wrapper, grace_seconds=0.2)

        assert wrapper.returncode == 0
        assert _is_live(child)
        assert unrelated.returncode is None
        assert _is_live(unrelated_process)
    finally:
        await release_task
        await _cleanup_process_tree(wrapper, child)
        if unrelated.returncode is None:
            unrelated.kill()
            await unrelated.wait()


@pytest.mark.asyncio
@pytest.mark.timeout(10)
async def test_run_marker_finds_child_after_wrapper_already_exited(tmp_path: Path):
    wrapper_exit_path = tmp_path / "let-marked-wrapper-exit"
    env = dict(os.environ)
    run_id = stamp_cli_run_id(env)
    wrapper, child = await _spawn_python_process_tree(
        tmp_path,
        wrapper_exit_path=wrapper_exit_path,
        wrapper_exit_code=7,
        env=env,
    )
    unrelated = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "import time; time.sleep(60)",
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    unrelated_process = psutil.Process(unrelated.pid)

    try:
        wrapper_exit_path.touch()
        await wrapper.wait()
        assert wrapper.returncode == 7
        assert _is_live(child)

        await wait_for_asyncio_process_or_kill_tree(
            wrapper,
            grace_seconds=0.1,
            run_id=run_id,
        )
        await _wait_until_stopped(child)

        assert not _is_live(child)
        assert unrelated.returncode is None
        assert _is_live(unrelated_process)
    finally:
        await _cleanup_process_tree(wrapper, child)
        if unrelated.returncode is None:
            unrelated.kill()
            await unrelated.wait()


@pytest.mark.asyncio
@pytest.mark.timeout(10)
@pytest.mark.skipif(os.name == "nt", reason="SIGTERM handlers are POSIX-specific")
async def test_explicit_termination_sweeps_marker_after_clean_wrapper_exit(tmp_path: Path):
    orphan_gate = tmp_path / "orphan-marked-child"
    env = dict(os.environ)
    run_id = stamp_cli_run_id(env)
    original_wrapper, child = await _spawn_python_process_tree(
        tmp_path,
        wrapper_exit_path=orphan_gate,
        env=env,
    )
    orphan_gate.touch()
    await original_wrapper.wait()
    assert original_wrapper.returncode == 0
    assert _is_live(child)

    ready_path = tmp_path / "clean-term-wrapper-ready"
    wrapper = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        _CLEAN_TERM_WRAPPER,
        str(ready_path),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    deadline = asyncio.get_running_loop().time() + 5
    while not ready_path.exists() and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)
    assert ready_path.exists()

    try:
        await terminate_asyncio_process_tree(
            wrapper,
            grace_seconds=0.1,
            run_id=run_id,
        )
        await _wait_until_stopped(child)

        assert wrapper.returncode == 0
        assert not _is_live(child)
    finally:
        await _cleanup_process_tree(original_wrapper, child)
        if wrapper.returncode is None:
            wrapper.kill()
            await wrapper.wait()


@pytest.mark.asyncio
@pytest.mark.timeout(10)
@pytest.mark.parametrize(
    ("worker_type", "grace_constant"),
    [
        (
            ClaudeCLIStreamWorker,
            "flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker.CANCEL_GRACE_SECONDS",
        ),
        (
            CodexCLIStreamWorker,
            "flow_sdk.builtin.agentic_process.cli_drivers.codex.stream_worker.CANCEL_GRACE_SECONDS",
        ),
        (
            CopilotCLIStreamWorker,
            "flow_sdk.builtin.agentic_process.cli_drivers.copilot.stream_worker.CANCEL_GRACE_SECONDS",
        ),
        (
            OpenCodeCLIStreamWorker,
            "flow_sdk.builtin.agentic_process.cli_drivers.opencode.stream_worker.CANCEL_GRACE_SECONDS",
        ),
    ],
    ids=["claude", "codex", "copilot", "opencode"],
)
async def test_worker_close_session_kills_wrapper_and_child(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    worker_type: type[Any],
    grace_constant: str,
):
    monkeypatch.setattr(grace_constant, 0.1)
    wrapper, child = await _spawn_python_process_tree(tmp_path)
    worker = worker_type()
    worker._proc = wrapper

    try:
        await worker.close_session()
        await _wait_until_stopped(child)

        assert wrapper.returncode is not None
        assert not _is_live(child)
    finally:
        await _cleanup_process_tree(wrapper, child)
