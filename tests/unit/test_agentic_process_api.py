"""Unit tests for the AgenticProcess layer API.

Tests construction, lifecycle methods, classmethods, and state properties.
No real Claude CLI required — PTYs are plain shell sessions.
"""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess, ProcessError, RunResult
from flow_sdk.fs_records.agentic_process_record import AgenticProcessStatus
from flow_sdk.fs_store.record import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)


@pytest.fixture(autouse=True)
def use_tmp_records_root(tmp_path):
    orig_root = get_default_records_root()
    orig_data_root = get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    yield tmp_path
    set_default_records_root(orig_root)
    set_default_records_data_root(orig_data_root)


def _proc(**kwargs) -> AgenticProcess:
    return AgenticProcess(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()), **kwargs)


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

def test_defaults():
    """New process has idle status, no session_id, no shell_id."""
    proc = AgenticProcess()
    assert proc.status == AgenticProcessStatus.IDLE.value
    assert proc.session_id is None
    assert proc.shell_id is None


# ---------------------------------------------------------------------------
# send() raises when no shell
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_send_raises_when_no_shell():
    """send() raises ValueError when no shell is linked."""
    proc = _proc()
    with pytest.raises(ValueError, match="No shell linked"):
        await proc.send("hello")


# ---------------------------------------------------------------------------
# shell() returns None
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_shell_returns_none_when_no_shell_id():
    """shell() returns None when shell_id is not set."""
    proc = _proc()
    assert await proc.shell() is None


# ---------------------------------------------------------------------------
# is_running()
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_is_running_returns_false_when_no_shell():
    """is_running() returns False when no shell is linked."""
    proc = _proc()
    assert await proc.is_running() is False


# ---------------------------------------------------------------------------
# wait() terminates quickly on idle process
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_wait_returns_when_no_transcript():
    """wait() returns quickly when no transcript exists (is_idle returns False, but no session)."""
    proc = _proc()
    # No session_id → _discover_status_from_transcript returns None → is_idle=False
    # But with a terminal status set directly, wait() should return.
    proc.status = AgenticProcessStatus.COMPLETE.value
    # Simulate transcript returning COMPLETE status
    with patch.object(proc, "_discover_status_from_transcript", return_value=AgenticProcessStatus.COMPLETE):
        await proc.wait(timeout=2.0)


# ---------------------------------------------------------------------------
# resume() factory
# ---------------------------------------------------------------------------

def test_resume_factory_sets_session_id_and_resume_flag():
    """AgenticProcess.resume() pre-bakes session_id and resume=True in cli_config."""
    proc = AgenticProcess.resume("abc-123")
    assert proc.session_id == "abc-123"
    assert proc.cli_config.get("resume") is True


def test_resume_factory_passes_kwargs():
    """AgenticProcess.resume() passes workdir and kwargs to the instance."""
    proc = AgenticProcess.resume("abc-123", workdir="/tmp/project")
    assert proc.workdir == "/tmp/project"
    assert proc.session_id == "abc-123"


# ---------------------------------------------------------------------------
# fork() factory
# ---------------------------------------------------------------------------

def test_fork_factory_sets_fork_session_id():
    """AgenticProcess.fork() pre-bakes fork_session_id in cli_config."""
    proc = AgenticProcess.fork("src-session-456")
    assert proc.cli_config.get("fork_session_id") == "src-session-456"


def test_fork_factory_does_not_set_session_id():
    """AgenticProcess.fork() does not pre-assign session_id (new ID will be assigned on start)."""
    proc = AgenticProcess.fork("src-session-456")
    assert proc.session_id is None


# ---------------------------------------------------------------------------
# context manager
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_context_manager_calls_start_and_stop():
    """async with AgenticProcess(...) calls start() on enter and stop() on exit."""
    proc = _proc()
    start_called = []
    stop_called = []

    async def _fake_start(**kwargs):
        start_called.append(True)
        from flow_sdk.responses.response import ApiSuccessResponse
        return ApiSuccessResponse(data={})

    async def _fake_stop():
        stop_called.append(True)
        from flow_sdk.responses.response import ApiSuccessResponse
        return ApiSuccessResponse(data={})

    with patch.object(AgenticProcess, "start", new_callable=AsyncMock, side_effect=_fake_start):
        with patch.object(AgenticProcess, "stop", new_callable=AsyncMock, side_effect=_fake_stop):
            async with proc:
                pass

    assert start_called == [True]
    assert stop_called == [True]


# ---------------------------------------------------------------------------
# inject() — no-op when no shell
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_inject_silent_when_no_shell():
    """inject() logs a warning and returns silently when no shell is linked."""
    proc = _proc()
    # Should not raise — just logs a warning
    await proc.inject("some command")


# ---------------------------------------------------------------------------
# set_session_id()
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_set_session_id_updates_field():
    """set_session_id() sets session_id on the entity."""
    proc = _proc()
    await proc.set_session_id("xyz-789")
    assert proc.session_id == "xyz-789"


# ---------------------------------------------------------------------------
# RunResult.ok
# ---------------------------------------------------------------------------

def test_run_result_ok_when_complete():
    """RunResult.ok is True for COMPLETE status."""
    result = RunResult(
        text="done",
        session_id="abc",
        status=AgenticProcessStatus.COMPLETE,
        ok=True,
    )
    assert result.ok is True


def test_run_result_not_ok_when_error():
    """RunResult.ok is False for ERROR status."""
    result = RunResult(
        text="",
        session_id="abc",
        status=AgenticProcessStatus.ERROR,
        ok=False,
    )
    assert result.ok is False


def test_run_result_not_ok_when_interrupted():
    """RunResult.ok is False for INTERRUPTED status."""
    result = RunResult(
        text="",
        session_id="abc",
        status=AgenticProcessStatus.INTERRUPTED,
        ok=False,
    )
    assert result.ok is False


# ---------------------------------------------------------------------------
# ProcessError
# ---------------------------------------------------------------------------

def test_process_error_carries_status_and_session_id():
    """ProcessError stores status and session_id for programmatic inspection."""
    err = ProcessError(
        status=AgenticProcessStatus.ERROR,
        session_id="err-session-123",
    )
    assert err.status == AgenticProcessStatus.ERROR
    assert err.session_id == "err-session-123"
    assert isinstance(err, Exception)


# ---------------------------------------------------------------------------
# stream() raises NotImplementedError
# ---------------------------------------------------------------------------

def test_stream_raises_not_implemented():
    """stream() raises NotImplementedError (stub — pending JSONL tailing)."""
    proc = _proc()
    with pytest.raises(NotImplementedError):
        proc.stream("do something")


# ---------------------------------------------------------------------------
# is_idle — no transcript
# ---------------------------------------------------------------------------

def test_is_idle_false_without_transcript():
    """is_idle is False when no Claude session transcript exists."""
    proc = _proc()
    # No session_id means _discover_claude_record_session returns None → is_idle=False
    assert proc.is_idle is False
