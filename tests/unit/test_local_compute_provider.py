"""Unit tests for local compute provider."""

import asyncio

import pytest

from flow_sdk.compute.providers.desktop.provider import (
    LocalComputeProvider,
    _build_interactive_pty_env,
    _pty_return_code,
)

# Import types from the flow-sdk
from flow_sdk.flowpad_types import ExecutionEnvironmentStatus, RuntimeEnvironment


def test_pty_return_code_preserves_signal_termination():
    class SignaledProcess:
        exitstatus = None
        signalstatus = 15

    assert _pty_return_code(SignaledProcess()) == -15


@pytest.fixture
async def local_provider():
    """Create a local compute provider."""
    provider = LocalComputeProvider()
    yield provider


@pytest.mark.asyncio
async def test_create_node(local_provider):
    """Test creating a local compute node."""
    runtime = RuntimeEnvironment(name="test-runtime")
    node_id = await local_provider.create_node("test-node", runtime)

    assert node_id is not None
    assert node_id.startswith("local_")


@pytest.mark.asyncio
async def test_startup_shutdown(local_provider):
    """Test node startup and shutdown."""
    runtime = RuntimeEnvironment(name="test-runtime")
    node_id = await local_provider.create_node("test-node", runtime)

    # Startup
    success = await local_provider.startup(node_id)
    assert success is True

    status = await local_provider.get_node_status(node_id)
    assert status == ExecutionEnvironmentStatus.READY

    # Shutdown
    await local_provider.shutdown(node_id)


@pytest.mark.asyncio
async def test_run_command(local_provider):
    """Test running a command."""
    runtime = RuntimeEnvironment(name="test-runtime")
    node_id = await local_provider.create_node("test-node", runtime)
    await local_provider.startup(node_id)

    # Run a simple command
    cmd = await local_provider.run_command(node_id, "echo 'hello world'")

    # Wait for completion
    await cmd.wait()

    assert cmd.exit_code == 0
    assert "hello world" in cmd.all_stdout

    await local_provider.shutdown(node_id)


@pytest.mark.asyncio
async def test_set_env(local_provider):
    """Test setting environment variables.

    The FlowPad local provider writes env vars persistently to ~/.bashrc (Unix)
    or via PowerShell (Windows). This test verifies the command executes
    successfully, not that the var is in the current process env.
    """
    runtime = RuntimeEnvironment(name="test-runtime")
    node_id = await local_provider.create_node("test-node", runtime)
    await local_provider.startup(node_id)

    # Set environment variable (writes to ~/.bashrc on Unix)
    # Should not raise
    await local_provider.set_env(node_id, "FLOWPAD_TEST_VAR", "test_value")

    # Remove environment variable (should not raise)
    await local_provider.set_env(node_id, "FLOWPAD_TEST_VAR", None)

    await local_provider.shutdown(node_id)


def test_interactive_pty_env_strips_inherited_color_suppression(monkeypatch):
    """Interactive PTYs should not inherit automation no-color markers."""
    monkeypatch.setenv("NO_COLOR", "1")
    monkeypatch.setenv("NODE_DISABLE_COLORS", "1")
    monkeypatch.setenv("CODEX_CI", "1")
    monkeypatch.setenv("TERM", "dumb")
    monkeypatch.setenv("COLORTERM", "")
    monkeypatch.setenv("CLICOLOR", "0")
    monkeypatch.setenv("CLICOLOR_FORCE", "false")
    monkeypatch.setenv("FORCE_COLOR", "off")
    monkeypatch.setenv("CLAUDECODE_ENTRYPOINT", "1")

    env = _build_interactive_pty_env("test-session")

    assert env["TERM"] == "xterm-256color"
    assert env["COLORTERM"] == "truecolor"
    assert env["FLOWPAD_PTY_SESSION_ID"] == "test-session"
    assert "NO_COLOR" not in env
    assert "NODE_DISABLE_COLORS" not in env
    assert "CODEX_CI" not in env
    assert "CLICOLOR" not in env
    assert "CLICOLOR_FORCE" not in env
    assert "FORCE_COLOR" not in env
    assert "CLAUDECODE_ENTRYPOINT" not in env


def test_interactive_pty_env_preserves_explicit_worker_env(monkeypatch):
    """Per-worker env is explicit intent and overlays the generic PTY defaults."""
    monkeypatch.setenv("NO_COLOR", "1")
    monkeypatch.setenv("COLORTERM", "")

    env = _build_interactive_pty_env(
        "test-session",
        {
            "NO_COLOR": "1",
            "COLORTERM": "24bit",
            "TERM": "ansi",
            "WORKER_ONLY": "yes",
        },
    )

    assert env["NO_COLOR"] == "1"
    assert env["COLORTERM"] == "24bit"
    assert env["TERM"] == "ansi"
    assert env["WORKER_ONLY"] == "yes"


@pytest.mark.asyncio
async def test_pty_session_creation(local_provider):
    """Test PTY session creation."""
    runtime = RuntimeEnvironment(name="test-pty-node")
    node_id = await local_provider.create_node("test-pty-node", runtime)
    await local_provider.startup(node_id)

    # Track output
    received_output = []

    def on_output(data: bytes):
        received_output.append(data)

    # Create PTY session
    pty_info = await local_provider.get_or_create_pty_session(
        node_id, "test-session", on_output, rows=24, cols=80
    )

    assert pty_info is not None
    assert "pid" in pty_info
    assert pty_info["pid"] > 0

    await asyncio.sleep(0.5)  # Give shell time to start

    await local_provider.shutdown(node_id)


@pytest.mark.long  # 1.14s
@pytest.mark.asyncio
async def test_pty_input(local_provider):
    """Test sending input to PTY session."""
    runtime = RuntimeEnvironment(name="test-pty-node")
    node_id = await local_provider.create_node("test-pty-node", runtime)
    await local_provider.startup(node_id)

    received_output = []

    def on_output(data: bytes):
        received_output.append(data)

    # Create PTY session
    await local_provider.get_or_create_pty_session(
        node_id, "test-session", on_output, rows=24, cols=80
    )

    await asyncio.sleep(0.3)

    # Send command to PTY
    await local_provider.send_pty_input(
        node_id, "test-session", b"echo 'test'\n", cols=80, rows=24
    )

    # Wait for output
    await asyncio.sleep(0.5)

    # Check that we received some output
    assert len(received_output) > 0

    await local_provider.close_pty_session(node_id, "test-session")
    await local_provider.shutdown(node_id)


@pytest.mark.asyncio
async def test_pty_resize(local_provider):
    """Test resizing PTY terminal."""
    runtime = RuntimeEnvironment(name="test-pty-node")
    node_id = await local_provider.create_node("test-pty-node", runtime)
    await local_provider.startup(node_id)

    received_output = []

    def on_output(data: bytes):
        received_output.append(data)

    # Create PTY session
    await local_provider.get_or_create_pty_session(
        node_id, "test-session", on_output, rows=24, cols=80
    )

    await asyncio.sleep(0.3)

    # Resize terminal
    await local_provider.resize_pty(node_id, "test-session", cols=120, rows=40)

    # Should not raise
    assert True

    await local_provider.close_pty_session(node_id, "test-session")
    await local_provider.shutdown(node_id)


@pytest.mark.asyncio
async def test_pty_close(local_provider):
    """Test closing PTY session."""
    runtime = RuntimeEnvironment(name="test-pty-node")
    node_id = await local_provider.create_node("test-pty-node", runtime)
    await local_provider.startup(node_id)

    received_output = []

    def on_output(data: bytes):
        received_output.append(data)

    # Create and close PTY session
    await local_provider.get_or_create_pty_session(
        node_id, "test-session", on_output, rows=24, cols=80
    )

    await asyncio.sleep(0.2)

    await local_provider.close_pty_session(node_id, "test-session")

    # Session should be closed
    assert (node_id, "test-session") not in local_provider._pty_processes

    await local_provider.shutdown(node_id)
