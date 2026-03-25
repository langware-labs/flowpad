"""Tests for Shell and ShellResult (submodule 3)."""

import pytest

from flow_sdk.domain.environment import Environment
from flow_sdk.domain.shell import Shell, ShellResult


def test_run_sync_captures_output():
    """Shell.run_sync() captures stdout and exit_code."""
    env = Environment.load("/tmp")
    shell = Shell(env=env)
    result = shell.run_sync("echo hello")
    assert result.stdout == "hello\n"
    assert result.stderr == ""
    assert result.exit_code == 0


def test_run_sync_uses_env_vars():
    """Shell.run_sync() passes env_vars to the subprocess."""
    from flow_sdk.fs_records.environment_record import EnvironmentRecord

    record = EnvironmentRecord(
        name="test",
        work_dir="/tmp",
        env_vars={"MY_VAR": "test"},
    )
    env = Environment.fromRecord(record)
    shell = Shell(env=env)
    result = shell.run_sync("echo $MY_VAR")
    assert "test" in result.stdout


def test_run_sync_uses_work_dir(tmp_path):
    """Shell.run_sync() uses work_dir as cwd."""
    env = Environment.load(str(tmp_path))
    shell = Shell(env=env)
    result = shell.run_sync("pwd")
    # On macOS, /tmp may resolve to /private/tmp
    assert str(tmp_path) in result.stdout or tmp_path.resolve().as_posix() in result.stdout


@pytest.mark.asyncio
async def test_run_async_without_provider_raises():
    """Shell.run() raises RuntimeError when no provider is set."""
    env = Environment.load("/tmp")
    shell = Shell(env=env)
    with pytest.raises(RuntimeError, match="requires a provider"):
        await shell.run("echo hi")


@pytest.mark.asyncio
async def test_stream_without_provider_raises():
    """Shell.stream() raises RuntimeError when no provider is set."""
    env = Environment.load("/tmp")
    shell = Shell(env=env)
    with pytest.raises(RuntimeError, match="requires a provider"):
        async for _ in shell.stream("echo hi"):
            pass


def test_shell_result_dataclass():
    """ShellResult dataclass has correct fields."""
    r = ShellResult("out", "err", 1)
    assert r.stdout == "out"
    assert r.stderr == "err"
    assert r.exit_code == 1


def test_startClaudeSession_returns_session():
    """Shell.startClaudeSession() returns a ClaudeSession instance."""
    from flow_sdk.domain.claude_session import ClaudeSession

    env = Environment.load("/tmp")
    shell = Shell(env=env)
    session = shell.startClaudeSession()
    assert isinstance(session, ClaudeSession)
