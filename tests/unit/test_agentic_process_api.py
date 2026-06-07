"""Unit tests for the AgenticProcess layer API.

Tests construction, lifecycle methods, classmethods, and state properties.
No real Claude CLI required — PTYs are plain shell sessions.
"""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess, ProcessError, RunResult
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.fs_store.record_paths import (
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
    return AgenticProcess(id=str(uuid.uuid4()), **kwargs)


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

def test_defaults():
    """New process has NEW lifecycle status, no session_id, no shell_id."""
    proc = AgenticProcess()
    assert proc.status == ProcessStatus.NEW.value
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
    """wait() returns quickly when lifecycle has already failed and no transcript exists."""
    proc = _proc()
    proc.status = ProcessStatus.FAILED.value
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


def test_fork_factory_pre_assigns_new_session_id():
    """AgenticProcess.fork() pre-allocates a new session_id for the child process,
    distinct from the source session_id passed in."""
    proc = AgenticProcess.fork("src-session-456")
    assert proc.session_id is not None
    assert proc.session_id != "src-session-456"
    # cli_config carries the parent in fork_session_id and the new id in session_id.
    assert proc.cli_config.get("session_id") == proc.session_id
    assert proc.cli_config.get("fork_session_id") == "src-session-456"


def test_fork_factory_passes_workdir():
    """AgenticProcess.fork() passes workdir to the new instance."""
    proc = AgenticProcess.fork("src-session-456", workdir="/project/dir")
    assert proc.workdir == "/project/dir"


# ---------------------------------------------------------------------------
# CLAUDE_PROJECT_DIR lookup uses source session on fork
# ---------------------------------------------------------------------------

def test_claude_project_dir_lookup_uses_fork_session_id():
    """When forking, CLAUDE_PROJECT_DIR lookup uses fork_session_id, not the new session_id."""
    from unittest.mock import MagicMock
    from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeCliOptions

    proc = _proc(session_id="new-session-uuid")
    # Simulate cli_options with fork_session_id set
    cmd = ClaudeCliOptions(
        session_id="new-session-uuid",
        resume=True,
        fork_session_id="src-session-uuid",
        workdir="/project",
    )

    fake_record = MagicMock()
    fake_record.cwd = "/project/dir"

    calls = []

    def fake_discover(session_id):
        calls.append(session_id)
        return fake_record if session_id == "src-session-uuid" else None

    with patch.object(proc, "_discover_claude_record_session", side_effect=fake_discover):
        lookup_id = cmd.fork_session_id or proc.session_id
        session_rec = proc._discover_claude_record_session(lookup_id)

    assert calls == ["src-session-uuid"], "Should look up the source session, not the new one"
    assert session_rec is fake_record


# ---------------------------------------------------------------------------
# fork action
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_fork_action_creates_sibling_with_fork_session_id():
    """fork_action() calls AgenticProcess.fork() with source session_id and returns ApiSuccessResponse."""
    source = _proc(session_id="source-session-abc", workdir="/project")

    fake_new_proc = MagicMock()
    fake_new_proc.id = "new-proc-id"
    fake_new_proc.type = "agentic_process"
    fake_new_proc.save = AsyncMock()

    with patch.object(AgenticProcess, "fork", return_value=fake_new_proc) as mock_fork, \
         patch("flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info", return_value=None):
        result = await source.fork_action()

    mock_fork.assert_called_once_with(
        session_id="source-session-abc",
        workdir="/project",
        project_id=None,
        visible=False,
        shared_context_entities=[],
    )
    fake_new_proc.save.assert_awaited_once_with(None)
    from flow_sdk.responses.response import ApiSuccessResponse
    assert isinstance(result, ApiSuccessResponse)
    assert result.data == {"id": "new-proc-id", "type": "agentic_process"}


@pytest.mark.asyncio
async def test_fork_action_visible_false_by_default():
    """fork_action() defaults visible=False when request body is absent."""
    source = _proc(session_id="src-sess", workdir="/project")

    fake_new_proc = MagicMock()
    fake_new_proc.save = AsyncMock()
    fake_new_proc.to_dict = MagicMock(return_value={"id": "x"})

    with patch.object(AgenticProcess, "fork", return_value=fake_new_proc) as mock_fork, \
         patch("flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info", return_value=None):
        await source.fork_action()

    mock_fork.assert_called_once_with(
        session_id="src-sess",
        workdir="/project",
        project_id=None,
        visible=False,
        shared_context_entities=[],
    )


@pytest.mark.asyncio
async def test_fork_action_visible_true_when_passed():
    """fork_action() passes visible=True when request body contains visible: true."""
    source = _proc(session_id="src-sess", workdir="/project")

    fake_new_proc = MagicMock()
    fake_new_proc.save = AsyncMock()
    fake_new_proc.to_dict = MagicMock(return_value={"id": "x"})

    mock_req = MagicMock()
    mock_req.someone_typeid = None
    mock_req.get_post_data = AsyncMock(return_value={"visible": True})

    with patch.object(AgenticProcess, "fork", return_value=fake_new_proc) as mock_fork, \
         patch("flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info", return_value=mock_req):
        await source.fork_action()

    mock_fork.assert_called_once_with(
        session_id="src-sess",
        workdir="/project",
        project_id=None,
        visible=True,
        shared_context_entities=[],
    )


@pytest.mark.asyncio
async def test_fork_action_propagates_project_id():
    """fork_action() forwards self.project_id so the sibling keeps the parent's project."""
    source = _proc(session_id="src-sess", workdir="/project", project_id="proj-xyz")

    fake_new_proc = MagicMock()
    fake_new_proc.save = AsyncMock()
    fake_new_proc.to_dict = MagicMock(return_value={"id": "x"})

    with patch.object(AgenticProcess, "fork", return_value=fake_new_proc) as mock_fork, \
         patch("flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info", return_value=None):
        await source.fork_action()

    mock_fork.assert_called_once_with(
        session_id="src-sess",
        workdir="/project",
        project_id="proj-xyz",
        visible=False,
        shared_context_entities=[],
    )


# ---------------------------------------------------------------------------
# context manager
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_context_manager_calls_start_and_stop():
    """async with AgenticProcess(...) calls start_pty() on enter and exit() on __aexit__."""
    proc = _proc()
    start_called = []
    exit_called = []

    async def _fake_start(**kwargs):
        start_called.append(True)
        from flow_sdk.responses.response import ApiSuccessResponse
        return ApiSuccessResponse(data={})

    async def _fake_exit():
        exit_called.append(True)
        from flow_sdk.responses.response import ApiSuccessResponse
        return ApiSuccessResponse(data={})

    with patch.object(AgenticProcess, "start_pty", new_callable=AsyncMock, side_effect=_fake_start):
        with patch.object(AgenticProcess, "exit", new_callable=AsyncMock, side_effect=_fake_exit):
            async with proc:
                pass

    assert start_called == [True]
    assert exit_called == [True]


@pytest.mark.asyncio
async def test_start_promotes_stuck_starting_process_to_live_when_pty_is_attachable():
    """A wedged STARTING process should heal back to LIVE when its shell PTY is still attachable."""
    proc = _proc(
        status=ProcessStatus.STARTING.value,
        shell_id="shell-123",
        session_id="session-123",
    )
    shell = MagicMock()
    shell.id = "shell-123"
    shell.pty_pid = "pty-123"
    shell.worker_pid = 4321
    shell.model_dump.return_value = {"id": "shell-123"}
    shell.ensure_live_compute_node_binding = AsyncMock(return_value=True)
    shell.has_attachable_pty = AsyncMock(return_value=True)
    shell.worker_alive = AsyncMock(return_value=True)

    with patch.object(AgenticProcess, "shell", new=AsyncMock(return_value=shell)), \
         patch.object(AgenticProcess, "save", new=AsyncMock()) as save, \
         patch.object(AgenticProcess, "get_project", new=AsyncMock()) as get_project, \
         patch.object(AgenticProcess, "get_by_id", new_callable=AsyncMock, return_value=proc):
        result = await proc.start_pty()

    assert isinstance(result, ApiSuccessResponse)
    assert proc.status == ProcessStatus.RUNNING.value
    shell.ensure_live_compute_node_binding.assert_awaited_once_with()
    shell.has_attachable_pty.assert_awaited_once()
    shell.worker_alive.assert_awaited_once()
    save.assert_awaited_once()
    get_project.assert_not_awaited()


@pytest.mark.asyncio
async def test_start_persists_visible_true_on_running_reattach():
    """Opening a hidden live process should make it visible without relaunching the worker."""
    proc = _proc(
        status=ProcessStatus.RUNNING.value,
        shell_id="shell-123",
        session_id="session-123",
        visible=False,
    )
    shell = MagicMock()
    shell.id = "shell-123"
    shell.pty_pid = "pty-123"
    shell.worker_pid = 4321
    shell.model_dump.return_value = {"id": "shell-123"}
    shell.ensure_live_compute_node_binding = AsyncMock(return_value=True)
    shell.has_attachable_pty = AsyncMock(return_value=True)
    shell.worker_alive = AsyncMock(return_value=True)

    with patch.object(AgenticProcess, "shell", new=AsyncMock(return_value=shell)), \
         patch.object(AgenticProcess, "save", new=AsyncMock()) as save, \
         patch.object(AgenticProcess, "get_project", new=AsyncMock()) as get_project, \
         patch.object(AgenticProcess, "get_by_id", new_callable=AsyncMock, return_value=proc):
        result = await proc.start_pty(visible=True)

    assert isinstance(result, ApiSuccessResponse)
    assert proc.visible is True
    assert proc.status == ProcessStatus.RUNNING.value
    save.assert_awaited_once()
    get_project.assert_not_awaited()


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
        status=WorkerStatus.COMPLETE,
        ok=True,
    )
    assert result.ok is True


def test_run_result_not_ok_when_error():
    """RunResult.ok is False for ERROR status."""
    result = RunResult(
        text="",
        session_id="abc",
        status=WorkerStatus.ERROR,
        ok=False,
    )
    assert result.ok is False


def test_run_result_not_ok_when_interrupted():
    """RunResult.ok is False for INTERRUPTED status."""
    result = RunResult(
        text="",
        session_id="abc",
        status=WorkerStatus.INTERRUPTED,
        ok=False,
    )
    assert result.ok is False


# ---------------------------------------------------------------------------
# ProcessError
# ---------------------------------------------------------------------------

def test_process_error_carries_status_and_session_id():
    """ProcessError stores status and session_id for programmatic inspection."""
    err = ProcessError(
        status=WorkerStatus.ERROR,
        session_id="err-session-123",
    )
    assert err.status == WorkerStatus.ERROR
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

def test_is_idle_true_when_not_running():
    """is_idle is True when lifecycle is NEW."""
    proc = _proc()
    assert proc.is_idle is True


def test_is_idle_false_when_running():
    """is_idle is False when lifecycle is LIVE."""
    proc = _proc()
    proc.status = ProcessStatus.RUNNING.value
    assert proc.is_idle is False
