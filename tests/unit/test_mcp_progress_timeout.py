"""Test MCP progress-aware timeout functionality.

The issue: MCP servers return long answers with progress chunks, but the client
still times out because progress notifications don't reset the read timeout.

This test verifies that when progress is being received, the timeout should
not trigger even if the overall operation takes longer than the read_timeout.
"""

import asyncio
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

import pytest

from flow_sdk.core.flow.mcp_server import FlowPadMCPServer, ProgressAwareTimeout


@pytest.mark.asyncio
async def test_progress_aware_timeout_not_timed_out_initially():
    """Test that the timeout handler is not timed out initially."""
    timeout_handler = ProgressAwareTimeout(timeout_seconds=1.0)
    assert not timeout_handler.is_timed_out(), "Should not be timed out initially"


@pytest.mark.asyncio
async def test_progress_aware_timeout_after_waiting_less_than_timeout():
    """Test that waiting less than timeout doesn't trigger timeout."""
    timeout_handler = ProgressAwareTimeout(timeout_seconds=1.0)

    await asyncio.sleep(0.3)
    assert not timeout_handler.is_timed_out(), "Should not be timed out after 0.3s with 1s timeout"


@pytest.mark.asyncio
async def test_progress_aware_timeout_after_waiting_more_than_timeout():
    """Test that waiting more than timeout triggers timeout."""
    timeout_handler = ProgressAwareTimeout(timeout_seconds=0.5)

    await asyncio.sleep(0.7)
    assert timeout_handler.is_timed_out(), "Should be timed out after 0.7s with 0.5s timeout"


@pytest.mark.long  # 1.80s
@pytest.mark.asyncio
async def test_progress_aware_timeout_reset_extends_timeout():
    """
    Test that resetting the timeout extends the window.

    This is the key behavior for progress-aware timeout:
    - Start with 1 second timeout
    - Wait 0.6 seconds (would timeout at 1 second)
    - Reset the timeout
    - Wait another 0.6 seconds (total 1.2 seconds from start)
    - Should NOT be timed out because we reset at 0.6s
    """
    timeout_handler = ProgressAwareTimeout(timeout_seconds=1.0)

    # Wait less than timeout
    await asyncio.sleep(0.6)
    assert not timeout_handler.is_timed_out(), "Should not be timed out after 0.6s"

    # Reset the timeout (simulating progress received)
    timeout_handler.reset()

    # Wait another 0.6s (total 1.2s from start, but only 0.6s from reset)
    await asyncio.sleep(0.6)
    assert not timeout_handler.is_timed_out(), "Should not be timed out 0.6s after reset"

    # Wait until timeout from last reset (0.6s more = 1.2s from reset)
    await asyncio.sleep(0.6)
    assert timeout_handler.is_timed_out(), "Should be timed out 1.2s after reset (with 1s timeout)"


@pytest.mark.long  # 2.21s
@pytest.mark.asyncio
async def test_progress_aware_timeout_multiple_resets():
    """Test that multiple resets keep extending the timeout."""
    timeout_handler = ProgressAwareTimeout(timeout_seconds=0.5)

    # Reset every 0.3s, should never timeout
    for _ in range(5):
        await asyncio.sleep(0.3)
        assert not timeout_handler.is_timed_out(), "Should not timeout with regular resets"
        timeout_handler.reset()

    # Now wait past the timeout without reset
    await asyncio.sleep(0.7)
    assert timeout_handler.is_timed_out(), "Should timeout when not reset"


@pytest.mark.long  # 1.50s
@pytest.mark.asyncio
async def test_progress_aware_timeout_time_remaining():
    """Test the time_remaining method."""
    timeout_handler = ProgressAwareTimeout(timeout_seconds=1.0)

    # Initially should have ~1 second remaining
    remaining = timeout_handler.time_remaining()
    assert 0.9 <= remaining <= 1.0, f"Expected ~1s remaining, got {remaining}"

    # Wait a bit
    await asyncio.sleep(0.3)
    remaining = timeout_handler.time_remaining()
    assert 0.6 <= remaining <= 0.8, f"Expected ~0.7s remaining, got {remaining}"

    # Reset
    timeout_handler.reset()
    remaining = timeout_handler.time_remaining()
    assert 0.9 <= remaining <= 1.0, f"Expected ~1s remaining after reset, got {remaining}"

    # Wait past timeout
    await asyncio.sleep(1.2)
    remaining = timeout_handler.time_remaining()
    assert remaining == 0, f"Expected 0s remaining, got {remaining}"


@pytest.mark.asyncio
async def test_progress_aware_timeout_zero_timeout():
    """Test with zero timeout (immediately times out)."""
    timeout_handler = ProgressAwareTimeout(timeout_seconds=0.0)

    # Should immediately be timed out (or very close to it)
    assert timeout_handler.is_timed_out(), "Should be timed out immediately with 0s timeout"


@pytest.mark.asyncio
async def test_progress_aware_timeout_very_short():
    """Test with very short timeout."""
    timeout_handler = ProgressAwareTimeout(timeout_seconds=0.1)

    # Should not be timed out immediately
    assert not timeout_handler.is_timed_out(), "Should not be timed out immediately"

    # Wait past timeout
    await asyncio.sleep(0.15)
    assert timeout_handler.is_timed_out(), "Should be timed out after 0.15s with 0.1s timeout"


# Integration tests for FlowPadMCPServer.call_tool_with_progress_timeout


@dataclass
class MockCallToolResult:
    """Mock MCP CallToolResult."""

    structuredContent: dict[str, Any] | None = None
    content: list = None

    def __post_init__(self):
        if self.content is None:
            self.content = []


def create_mock_client_with_progress(
    duration_seconds: float,
    chunk_interval: float,
    result_content: dict[str, Any],
):
    """
    Create a mock ClientSession that simulates a long-running tool with progress updates.

    Args:
        duration_seconds: Total duration of the simulated operation
        chunk_interval: How often to send progress updates
        result_content: The structured content to return
    """
    mock_client = MagicMock()

    async def mock_call_tool(name, arguments, read_timeout_seconds=None, progress_callback=None):
        """Simulate a long-running tool call with progress updates."""
        total_chunks = int(duration_seconds / chunk_interval)

        for i in range(total_chunks):
            if progress_callback:
                await progress_callback(i + 1, total_chunks, f"Processing chunk {i + 1}")
            await asyncio.sleep(chunk_interval)

        return MockCallToolResult(structuredContent=result_content)

    mock_client.call_tool = mock_call_tool
    return mock_client


def create_mock_client_no_progress(duration_seconds: float, result_content: dict[str, Any]):
    """
    Create a mock ClientSession that simulates a long-running tool WITHOUT progress updates.
    """
    mock_client = MagicMock()

    async def mock_call_tool(name, arguments, read_timeout_seconds=None, progress_callback=None):
        """Simulate a long-running tool call without progress updates."""
        await asyncio.sleep(duration_seconds)
        return MockCallToolResult(structuredContent=result_content)

    mock_client.call_tool = mock_call_tool
    return mock_client


def create_mock_server_with_client(mock_client):
    """Create a FlowPadMCPServer with a mock client injected."""
    server = FlowPadMCPServer(url="http://localhost:8101/mcp")
    server._client = mock_client
    return server


@pytest.mark.long  # 1.81s
@pytest.mark.asyncio
async def test_call_tool_with_progress_timeout_succeeds_with_progress():
    """
    Test that call_tool_with_progress_timeout succeeds when progress is received.

    This simulates the real scenario where a tool takes longer than the timeout
    but sends progress updates to indicate it's still working.
    """
    # Create a mock client that takes 2 seconds but sends progress every 0.3s
    mock_client = create_mock_client_with_progress(
        duration_seconds=2.0,
        chunk_interval=0.3,
        result_content={"status": "success", "data": "test_result"},
    )
    server = create_mock_server_with_client(mock_client)

    progress_received = []

    async def track_progress(progress: float, total: float | None, message: str | None):
        progress_received.append({"progress": progress, "total": total, "message": message})

    # Use a 1 second progress timeout - would fail if progress didn't reset it
    result = await server.call_tool_with_progress_timeout(
        name="test_tool",
        arguments={"arg1": "value1"},
        progress_callback=track_progress,
        progress_timeout_seconds=1.0,
    )

    # Verify the result
    assert result["status"] == "success"
    assert result["data"] == "test_result"

    # Verify progress was received
    assert len(progress_received) >= 5, f"Expected at least 5 progress updates, got {len(progress_received)}"


@pytest.mark.long  # 1.00s
@pytest.mark.asyncio
async def test_call_tool_with_progress_timeout_times_out_without_progress():
    """
    Test that call_tool_with_progress_timeout times out when no progress is received.

    This ensures the timeout still works when there's no progress to reset it.
    """
    # Create a mock client that takes 3 seconds without any progress
    mock_client = create_mock_client_no_progress(
        duration_seconds=3.0,
        result_content={"status": "success"},
    )
    server = create_mock_server_with_client(mock_client)

    # Use a 1 second progress timeout - should fail because no progress
    with pytest.raises(TimeoutError) as exc_info:
        await server.call_tool_with_progress_timeout(
            name="slow_tool",
            arguments={},
            progress_callback=None,
            progress_timeout_seconds=1.0,
        )

    assert "Timed out" in str(exc_info.value)
    assert "slow_tool" in str(exc_info.value)


@pytest.mark.asyncio
async def test_call_tool_with_progress_timeout_handles_wrapped_result():
    """Test that wrapped primitive results are correctly unwrapped."""
    mock_client = MagicMock()

    async def mock_call_tool(name, arguments, read_timeout_seconds=None, progress_callback=None):
        # MCP SDK wraps primitives in a 'result' key
        return MockCallToolResult(structuredContent={"result": "unwrapped_value"})

    mock_client.call_tool = mock_call_tool
    server = create_mock_server_with_client(mock_client)

    result = await server.call_tool_with_progress_timeout(
        name="test_tool",
        arguments={},
        progress_timeout_seconds=5.0,
    )

    # Should be unwrapped
    assert result == "unwrapped_value"


@pytest.mark.asyncio
async def test_call_tool_with_progress_timeout_propagates_exceptions():
    """Test that exceptions from the tool call are properly propagated."""
    mock_client = MagicMock()

    async def mock_call_tool(name, arguments, read_timeout_seconds=None, progress_callback=None):
        raise ValueError("Tool execution failed")

    mock_client.call_tool = mock_call_tool
    server = create_mock_server_with_client(mock_client)

    with pytest.raises(ValueError) as exc_info:
        await server.call_tool_with_progress_timeout(
            name="failing_tool",
            arguments={},
            progress_timeout_seconds=5.0,
        )

    assert "Tool execution failed" in str(exc_info.value)


@pytest.mark.asyncio
async def test_call_tool_with_progress_timeout_raises_without_client():
    """Test that calling without initialized client raises RuntimeError."""
    server = FlowPadMCPServer(url="http://localhost:8101/mcp")
    # Don't set _client - it's None

    with pytest.raises(RuntimeError) as exc_info:
        await server.call_tool_with_progress_timeout(
            name="test_tool",
            arguments={},
        )

    assert "client is not initialized" in str(exc_info.value)
