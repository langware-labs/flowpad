"""
Unit tests for shell streaming functionality.

These tests validate shell output streaming without external dependencies.
They test callback handlers, FlowData element types, and shell output tagging.

Migrated from: flowpad/hub/tests/unit/test_shell_streaming.py
- Tests 1-2: Migrated (DIRECT_MIGRATE) - only use core flow engine types
- Tests 3-5: Skipped (cloud-only) - depend on cloud MCP shell server
  (flowpad.hub.core.flow.mcp_servers.copy_to_sandbox.shell_mcp)
"""

from flow_sdk.core.flow.models.flow_data import FlowData, FlowElementType
from flow_sdk.core.flow.streaming.response_handler import StreamingResponseHandler


async def test_completion_streams_shell_output_with_correct_tag():
    """
    Test that /completion endpoint streams shell output with flow-shell-output tag, not flow-chat.

    This validates that shell command output from MCP progress callbacks uses the correct
    FlowElementType.SHELL_OUTPUT instead of FlowElementType.CHAT.

    Bug reproduction: Shell output was being streamed via on_new_chunk() which uses on_chat(),
    causing output to be tagged as 'chat' instead of 'shell-output'.
    """
    # Create a callback handler to capture the FlowData elements
    callback_handler = StreamingResponseHandler()

    # Capture all FlowData elements sent to the handler
    captured_flow_data: list[FlowData] = []
    original_on_flow_data = callback_handler.on_flow_data

    async def capture_flow_data(flow_data: FlowData | None):
        if flow_data is not None:
            captured_flow_data.append(flow_data)
        await original_on_flow_data(flow_data)

    callback_handler.on_flow_data = capture_flow_data

    # Test using the on_shell_output method (same as what mcp_server.py and use_tool.py now use)
    stdout_content = "Hello from shell stdout"
    stderr_content = "Error from shell stderr"

    # Use the callback handler's on_shell_output method
    await callback_handler.on_shell_output(stdout_content, "stdout")
    await callback_handler.on_shell_output(stderr_content, "stderr")

    # Verify that captured FlowData has correct element type
    assert len(captured_flow_data) == 2, f"Expected 2 FlowData elements, got {len(captured_flow_data)}"

    stdout_fd = captured_flow_data[0]
    stderr_fd = captured_flow_data[1]

    # These assertions validate the FIX - shell output must use SHELL_OUTPUT, not CHAT
    assert stdout_fd.element_type == FlowElementType.SHELL_OUTPUT, (
        f"stdout should be shell-output, got {stdout_fd.element_type}"
    )
    assert stderr_fd.element_type == FlowElementType.SHELL_OUTPUT, (
        f"stderr should be shell-output, got {stderr_fd.element_type}"
    )

    # Verify channel attribute is preserved
    assert stdout_fd.attributes.get("channel") == "stdout", "stdout should have channel=stdout"
    assert stderr_fd.attributes.get("channel") == "stderr", "stderr should have channel=stderr"

    # Verify content is correct
    assert stdout_fd.flow_value == stdout_content
    assert stderr_fd.flow_value == stderr_content


async def test_shell_python_command_streams_to_shell_output_tag():
    """
    Test that /shell python command streams output to flow-shell-output tag.

    This simulates what happens when a user runs '/shell python -c "print(...)"'
    and verifies that the output is streamed with the correct element type.
    """
    # Create a callback handler to capture the FlowData elements
    callback_handler = StreamingResponseHandler()

    # Capture all FlowData elements sent to the handler
    captured_flow_data: list[FlowData] = []
    original_on_flow_data = callback_handler.on_flow_data

    async def capture_flow_data(flow_data: FlowData | None):
        if flow_data is not None:
            captured_flow_data.append(flow_data)
        await original_on_flow_data(flow_data)

    callback_handler.on_flow_data = capture_flow_data

    # Simulate output from: /shell python -c "print('Hello World')"
    python_output = "Hello World\n"

    # This is what the progress callback in mcp_server.py and use_tool.py now does
    await callback_handler.on_shell_output(python_output, "stdout")

    # Verify the output was captured with correct element type
    assert len(captured_flow_data) == 1, f"Expected 1 FlowData element, got {len(captured_flow_data)}"

    output_fd = captured_flow_data[0]

    # Verify element type is shell-output, NOT chat
    assert output_fd.element_type == FlowElementType.SHELL_OUTPUT, (
        f"Python output should be shell-output, got {output_fd.element_type}"
    )

    # Verify it's NOT chat (the bug we fixed)
    assert output_fd.element_type != "chat", "Python output should NOT be tagged as chat"

    # Verify channel and content
    assert output_fd.attributes.get("channel") == "stdout", "Should have channel=stdout"
    assert output_fd.flow_value == python_output, f"Content mismatch: {output_fd.flow_value}"
