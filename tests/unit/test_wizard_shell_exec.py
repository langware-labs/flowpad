"""``run_shell`` — the only wizard module that actually spawns a process.

Deliberately no timeout test. Asserting a timeout means waiting for one, which
is a wall-clock test wearing a unit test's clothes; the timeout POLICY (an
unanswered check resolves to EXECUTE, never SATISFIED) is asserted purely in
``test_wizard_check_outcome.py``.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

from flow_sdk.core.wizard.exec import run_shell

pytestmark = [
    pytest.mark.timeout(5),
    pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell built-ins"),
]


@pytest.mark.asyncio
async def test_exit_code_is_reported_verbatim(tmp_path):
    result = await run_shell("exit 3", timeout_seconds=5, workdir=Path(tmp_path), platform="linux")
    assert result.returncode == 3
    assert not result.ok
    assert not result.timed_out


@pytest.mark.asyncio
async def test_success_is_exit_zero(tmp_path):
    result = await run_shell("exit 0", timeout_seconds=5, workdir=Path(tmp_path), platform="linux")
    assert result.ok


@pytest.mark.asyncio
async def test_stdout_is_captured(tmp_path):
    result = await run_shell("echo hi", timeout_seconds=5, workdir=Path(tmp_path), platform="linux")
    assert "hi" in result.stdout


@pytest.mark.asyncio
async def test_a_step_can_see_its_own_identity(tmp_path):
    result = await run_shell(
        "echo $FLOWPAD_WIZARD_STEP", timeout_seconds=5, workdir=Path(tmp_path),
        extra_env={"FLOWPAD_WIZARD_STEP": "python3"}, platform="linux",
    )
    assert "python3" in result.stdout


@pytest.mark.asyncio
async def test_stdin_is_closed_so_a_prompt_cannot_hang_a_headless_run(tmp_path):
    """An installer that decides to ask a question must fail on a closed stdin
    rather than block forever waiting for an answer nobody is there to give."""
    result = await run_shell("read x", timeout_seconds=5, workdir=Path(tmp_path), platform="linux")
    assert not result.timed_out, "a read on closed stdin must return, not wait"


@pytest.mark.asyncio
async def test_the_tail_prefers_stderr_because_that_is_where_the_reason_is(tmp_path):
    result = await run_shell(
        "echo out; echo boom 1>&2; exit 1", timeout_seconds=5,
        workdir=Path(tmp_path), platform="linux",
    )
    assert "boom" in result.tail()


@pytest.mark.asyncio
async def test_a_command_runs_in_the_wizard_workdir(tmp_path):
    result = await run_shell("pwd", timeout_seconds=5, workdir=Path(tmp_path), platform="linux")
    assert str(tmp_path) in result.stdout
