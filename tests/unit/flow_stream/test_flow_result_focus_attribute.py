"""
Test to verify that the focus attribute on flow-result tags is preserved during parsing and conversion.

This test verifies that when an LLM generates a <flow-result focus="something"> tag,
the focus attribute is parsed correctly and preserved when the FlowData
is created and sent to the client.
"""

from pydantic_ai.messages import TextPart

from flow_sdk.core.flow.tools import FlowTextHandler
from flow_sdk.core.flow.models.flow_data import FlowData, FlowElementType
from flow_sdk.core.flow.streaming.response_handler import CallbackHandler


class MockCallbackHandler(CallbackHandler):
    """Mock callback handler that captures result FlowData objects.

    Implements all CallbackHandler methods as no-ops except on_result,
    which captures FlowData objects for test assertions.
    """

    def __init__(self):
        self.captured_results: list[FlowData] = []

    async def on_result(self, result: FlowData):
        """Capture result FlowData objects."""
        self.captured_results.append(result)

    async def on_user_message(self, message: str):
        pass

    async def on_flow_data(self, flow_data: FlowData):
        pass

    async def on_status(self, status: str):
        pass

    async def on_ux_status(self, status: str, delay_ms: float = 1000.0):
        pass

    async def on_focus(self, focus: str, args: dict[str, str] | None = None):
        pass

    async def on_new_sources(self, sources: list[str]):
        pass

    async def on_trace(self, message: str, level: str = "info"):
        pass

    async def on_shell_input(self, command: str, workdir: str):
        pass

    async def on_shell_output(self, content: str, channel: str):
        pass

    async def on_new_chunk(self, chunk: str):
        pass

    async def on_cached_message(self, cached_message: str):
        pass

    async def on_error(self, error: Exception):
        pass

    async def on_llm_end(self):
        pass

    async def on_state(self, key: str, data: dict):
        pass

    async def on_end(self):
        pass

    async def on_reasoning(self, chunk: str):
        pass

    async def on_chat(self, chunk: str):
        pass


async def test_flow_result_focus_attribute_is_preserved():
    """
    Test that verifies the focus attribute on flow-result tags is preserved.

    Steps:
    1. LLM generates: <flow-result focus="editor" path="test.txt">...</flow-result>
    2. XML parser extracts focus="editor" into event["args"]
    3. FlowTextHandler creates FlowData and passes focus attribute
    4. FlowData is serialized back to XML with focus attribute preserved
    """
    # Create mock callback handler
    callback_handler = MockCallbackHandler()

    # Create FlowTextHandler
    async def no_op_on_write(path: str, content: str) -> None:
        pass

    handler = FlowTextHandler(
        callback_handler=callback_handler,
        on_write=no_op_on_write,
    )

    # Simulate LLM generating flow-result with focus attribute
    # This is what the LLM would generate
    llm_generated_xml = '<flow-result focus="editor" path="test.txt" name="Test File" data-type="object">{"type": "artifact", "path": "test.txt", "name": "Test File"}</flow-result>'

    # Process the XML through FlowTextHandler (simulating what happens during streaming)
    text_part = TextPart(content=llm_generated_xml)
    await handler.on_text_part_start(text_part)

    # Verify that a result was captured
    assert len(callback_handler.captured_results) > 0, "No result FlowData was captured"

    # Get the first result FlowData
    result_flow_data = callback_handler.captured_results[0]

    # Verify it's a result type
    assert result_flow_data.element_type == FlowElementType.RESULT, (
        f"Expected element_type to be RESULT, got {result_flow_data.element_type}"
    )

    # Verify that focus attribute IS present on the FlowData object
    assert result_flow_data.focus == "editor", (
        f"Expected FlowData.focus to be 'editor', but got: {result_flow_data.focus}"
    )

    # Serialize the FlowData back to XML (this is what gets sent to the client)
    serialized_xml = result_flow_data.start_tag_xml

    # Verify that focus attribute IS present in the serialized XML
    assert 'focus="editor"' in serialized_xml, (
        f"Expected focus attribute to be PRESENT in serialized XML, "
        f"but it's missing from: {serialized_xml}\n"
        f"The focus attribute from the original <flow-result focus='editor'> tag "
        f"should be preserved in the serialized XML sent to the client."
    )

    # Verify that other attributes ARE also preserved
    assert "i=" in serialized_xml, f"Expected index attribute to be preserved in serialized XML: {serialized_xml}"
