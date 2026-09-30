"""A terminal a command runs in: found by what it belongs to, told what to run, asked whether it still runs,
and stopped without losing the terminal — ``Shell.belonging_to`` / ``run_command`` / ``running`` /
``interrupt``, on a real PTY. What the snippet viewer and a deployment's process both stand on.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from flow_sdk.builtin.shell import Shell
from tests.unit.conftest import kill_pty, poll_read


async def _until(predicate, timeout: float = 10.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not await predicate():
        if loop.time() > deadline:
            raise TimeoutError("condition never held")
        await asyncio.sleep(0.05)


async def _is_running(shell: Shell) -> bool:
    return await shell.running() is not None


async def _finished(shell: Shell, marker: str, timeout: float = 10.0) -> int:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        done = Shell.sentinel_exit(await shell.read(), marker)
        if done:
            return done[0]
        await asyncio.sleep(0.05)
    raise TimeoutError(f"{marker} never finished")


@pytest.mark.long  # 1.25s: three real terminals (~0.4s each to spawn)
async def test_a_thing_has_one_terminal_until_it_is_closed(tmp_path):
    key = f"test:{uuid.uuid4().hex}"
    first = await Shell.belonging_to(key, workdir=str(tmp_path), name="keyed")
    try:
        again = await Shell.belonging_to(key, workdir=str(tmp_path))
        assert again.id == first.id and again.is_alive
        other = await Shell.belonging_to(f"{key}-other", workdir=str(tmp_path))
        assert other.id != first.id
        await other.close()

        await first.close()
        fresh = await Shell.belonging_to(key, workdir=str(tmp_path))
        assert fresh.id != first.id, "a closed terminal is not handed out again"
        await fresh.close()
    finally:
        await kill_pty(first)


async def test_a_command_runs_in_the_terminal_and_its_end_carries_the_exit_code(tmp_path):
    shell = await Shell.belonging_to(f"test:{uuid.uuid4().hex}", workdir=str(tmp_path))
    try:
        marker = await shell.run_command("echo keyed-out; (exit 3)")
        assert await _finished(shell, marker) == 3
        assert b"keyed-out" in await shell.read()
        assert await shell.running() is None, "back at the prompt"
    finally:
        await shell.close()


@pytest.mark.parametrize("login_shell", [p for p in ("/bin/zsh", "/bin/bash") if __import__("os").path.exists(p)])
@pytest.mark.parametrize(("command", "ctrl_c", "exit_code"), [("true", False, 0), ("(exit 3)", False, 3), ("sleep 30", True, 130)])
async def test_the_end_marker_arrives_however_the_command_ends(tmp_path, monkeypatch, login_shell, command, ctrl_c, exit_code):
    """Ctrl-C included: zsh abandons the rest of an interrupted line, and a marker lost there
    leaves a viewer waiting forever."""
    monkeypatch.setenv("SHELL", login_shell)
    shell = await Shell.belonging_to(f"test:{uuid.uuid4().hex}", workdir=str(tmp_path))
    try:
        marker = await shell.run_command(command)
        if ctrl_c:
            await _until(lambda: _is_running(shell))
            await shell.write_raw(b"\x03")
        assert await _finished(shell, marker) == exit_code
    finally:
        await shell.close()


async def test_the_shells_own_env_reaches_what_it_runs(tmp_path):
    from flow_sdk.builtin.faas.compute_node import ComputeNode

    keyed = Shell(belongs_to=f"test:{uuid.uuid4().hex}", workdir=str(tmp_path), env={"FLOW_T_ENV": "from-env"},
                  compute_node_id=str((await ComputeNode.get_local()).id))
    await keyed.save()
    try:
        await keyed.start_pty()
        await keyed.write("echo got-$FLOW_T_ENV")
        await poll_read(keyed, b"got-from-env")
    finally:
        await keyed.close()


@pytest.mark.long  # ~1.5s: a real sleep, then Ctrl-C
async def test_interrupt_stops_the_command_and_keeps_the_terminal(tmp_path):
    shell = await Shell.belonging_to(f"test:{uuid.uuid4().hex}", workdir=str(tmp_path))
    try:
        marker = await shell.run_command("sleep 30")
        await _until(lambda: _is_running(shell))
        assert await shell.interrupt() is True
        assert await shell.running() is None
        await _finished(shell, marker)  # the shell carried on to the sentinel
        after = await shell.run_command("echo still-here")
        assert await _finished(shell, after) == 0
        assert shell.is_alive
    finally:
        await shell.close()


@pytest.mark.long  # ~2.5s: a command that ignores Ctrl-C, killed after the grace
async def test_a_command_deaf_to_ctrl_c_is_terminated_after_the_grace(tmp_path):
    shell = await Shell.belonging_to(f"test:{uuid.uuid4().hex}", workdir=str(tmp_path))
    try:
        await shell.run_command("""python3 -c 'import signal,time; signal.signal(signal.SIGINT, signal.SIG_IGN); time.sleep(30)'""")
        await _until(lambda: _is_running(shell))
        assert await shell.interrupt(grace=0.5) is True
        assert await shell.running() is None and shell.is_alive
    finally:
        await shell.close()


async def test_interrupting_an_idle_terminal_is_a_no_op(tmp_path):
    shell = await Shell.belonging_to(f"test:{uuid.uuid4().hex}", workdir=str(tmp_path))
    try:
        assert await shell.running() is None
        assert await shell.interrupt() is True
    finally:
        await shell.close()


async def test_run_and_capture_reads_the_output_between_the_command_and_its_marker(tmp_path):
    """``flow terminal run``'s path on a real terminal: the output, without the echoed command."""
    shell = await Shell.belonging_to(f"test:{uuid.uuid4().hex}", workdir=str(tmp_path))
    try:
        answer = await shell.run_and_capture("echo captured-line; (exit 4)", timeout=10)
        assert answer.returncode == 4
        assert answer.stdout.strip() == "captured-line"
    finally:
        await shell.close()
