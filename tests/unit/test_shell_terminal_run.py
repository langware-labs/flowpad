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
@pytest.mark.parametrize(
    ("command", "ctrl_c", "exit_code"),
    [("true", False, 0), ("(exit 3)", False, 3), pytest.param("sleep 30", True, 130, marks=pytest.mark.long)],  # ~1.2s
)
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
        # Nothing takes the foreground within the grace (it waits that long for a command typed a
        # moment ago to start), so nothing is signalled and nothing killed.
        assert await shell.interrupt(grace=0.3) is True
        assert shell.is_alive
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


@pytest.mark.long  # 1.0–1.5s: a real background job, then the prompt checked
async def test_a_background_process_at_the_prompt_is_not_a_running_command(tmp_path):
    """A prompt spawns helpers (an async git status) while the terminal sits idle: children of the
    shell that are not the command. Only the foreground job is — so the terminal is at its prompt."""
    shell = await Shell.belonging_to(f"test:{uuid.uuid4().hex}", workdir=str(tmp_path))
    try:
        marker = await shell.run_command("sleep 60 &")
        assert await _finished(shell, marker) == 0
        assert await shell.running() is None, "a background job is not the command in the foreground"
    finally:
        await shell.close()


@pytest.mark.long  # ~1.2s: a real command, stopped the moment it was typed
async def test_a_stop_sent_before_the_command_started_still_stops_it(tmp_path):
    """Stop pressed right after Run: the line may still sit in the line editor, where a Ctrl-C is a
    plain character and the command, starting a moment later, never sees it."""
    shell = await Shell.belonging_to(f"test:{uuid.uuid4().hex}", workdir=str(tmp_path))
    try:
        marker = await shell.run_command("sleep 30")
        assert await shell.interrupt(marker=marker) is True
        assert await _finished(shell, marker) == 130
        assert await shell.running() is None
    finally:
        await shell.close()


@pytest.mark.long  # ~1.1s: a real command outliving the wait, then stopped
async def test_run_and_capture_that_outlives_its_wait_is_timed_out_and_keeps_running(tmp_path):
    """The wait is bounded, never the command: the answer has no verdict, and the output so far."""
    shell = await Shell.belonging_to(f"test:{uuid.uuid4().hex}", workdir=str(tmp_path))
    try:
        answer = await shell.run_and_capture("echo still-going; sleep 30", timeout=0.4)
        assert answer.timed_out is True and answer.returncode is None and not answer.ok
        assert "still-going" in answer.stdout
        assert await shell.running() is not None, "the command keeps running in the terminal"
    finally:
        await shell.close()


async def test_run_and_capture_without_a_terminal_is_returned_not_raised():
    shell = Shell(name="t", workdir="/tmp", compute_node_id=str(uuid.uuid4()))
    answer = await shell.run_and_capture("ls", timeout=1)
    assert answer.returncode is None and answer.ran is False
    assert "No PTY session" in answer.stderr


@pytest.mark.long  # ~7s: the case itself is a shell whose rc file takes 6s
async def test_a_command_run_before_a_slow_starting_shell_shows_its_prompt_still_runs(tmp_path, monkeypatch):
    """A freshly spawned zsh is silent while it sources its rc files, and whatever runs there
    inherits the terminal as its stdin — a line typed then can be read by the rc instead of the
    shell (echoed, never run). So the command is typed once the prompt shows, however long that
    takes, never after a fixed wait."""
    if not __import__("os").path.exists("/bin/zsh"):
        pytest.skip("needs zsh")
    home = tmp_path / "home"
    home.mkdir()
    (home / ".zshrc").write_text("sleep 6\nread -t 2 -r swallowed || true\n")  # an rc step that reads stdin
    monkeypatch.setenv("HOME", str(home))  # the spawned zsh reads $HOME/.zshrc (ZDOTDIR=~)
    monkeypatch.setenv("SHELL", "/bin/zsh")
    shell = await Shell.belonging_to(f"test:{uuid.uuid4().hex}", workdir=str(tmp_path))
    try:
        marker = await shell.run_command("echo slow-rc-ok")
        assert await _finished(shell, marker, timeout=20) == 0
        assert b"slow-rc-ok" in Shell.sentinel_output(await shell.read(), marker)
    finally:
        await shell.close()
