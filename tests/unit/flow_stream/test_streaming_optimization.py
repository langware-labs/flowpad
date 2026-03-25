"""
Test to demonstrate bandwidth optimization from streaming consolidation.

This test shows the efficiency gains from consolidating streamable element types
(CHAT, REASONING, SHELL_OUTPUT, TRACE, CACHED_MESSAGE) versus the old approach
where each element required full XML tags.
"""

import asyncio

from flow_sdk.core.flow.models.flow_data import FlowData, FlowDataType, FlowElementType
from tests.flow_test_utils import UnifiedStreamingTestCallbackHandler, XMLStreamParser


async def test_streaming_bandwidth_optimization():
    """Demonstrate bandwidth savings from streaming consolidation."""

    # Create a realistic scenario: shell command with multi-line output
    mock_data = [
        FlowData(
            flow_value="Running command: npm install",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="npm WARN deprecated package@1.0.0\n",
            attributes={"element-type": FlowElementType.SHELL_OUTPUT, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="added 142 packages in 3.2s\n",
            attributes={"element-type": FlowElementType.SHELL_OUTPUT, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="12 packages are looking for funding\n",
            attributes={"element-type": FlowElementType.SHELL_OUTPUT, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="run `npm fund` for details\n",
            attributes={"element-type": FlowElementType.SHELL_OUTPUT, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="Installation complete!",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
    ]

    # Stream and collect
    handler = UnifiedStreamingTestCallbackHandler(verbose=False)
    handler.mock(mock_data)
    parser = XMLStreamParser()

    await parser.run(handler)

    # Collect parsed data
    parsed_data = []
    async for flow_data in parser:
        parsed_data.append(flow_data)

    non_end_elements = [fd for fd in parsed_data if fd.attributes.get("element-type") != "end"]

    # Should have 3 elements: chat, shell-output (consolidated), chat
    assert len(non_end_elements) == 3, f"Expected 3 consolidated elements, got {len(non_end_elements)}"

    # Verify types
    assert non_end_elements[0].attributes.get("element-type") == FlowElementType.CHAT
    assert non_end_elements[1].attributes.get("element-type") == FlowElementType.SHELL_OUTPUT
    assert non_end_elements[2].attributes.get("element-type") == FlowElementType.CHAT

    # Verify shell output was consolidated
    expected_shell_output = (
        "npm WARN deprecated package@1.0.0\n"
        "added 142 packages in 3.2s\n"
        "12 packages are looking for funding\n"
        "run `npm fund` for details\n"
    )
    assert non_end_elements[1].flow_value == expected_shell_output

    print(f"\n✅ Streaming optimization test passed!")


async def test_streamable_types_coverage():
    """Verify all streamable types consolidate correctly."""

    # Test each streamable type
    streamable_types = [
        FlowElementType.CHAT,
        FlowElementType.REASONING,
        FlowElementType.SHELL_OUTPUT,
        FlowElementType.TRACE,
        FlowElementType.CACHED_MESSAGE,
    ]

    print(f"\n📋 Testing {len(streamable_types)} streamable element types:")

    for elem_type in streamable_types:
        # Create multiple elements of the same type
        mock_data = [
            FlowData(
                flow_value=f"Part 1 of {elem_type}",
                attributes={"element-type": elem_type, "data-type": FlowDataType.TEXT},
            ),
            FlowData(
                flow_value=f" Part 2 of {elem_type}",
                attributes={"element-type": elem_type, "data-type": FlowDataType.TEXT},
            ),
            FlowData(
                flow_value=f" Part 3 of {elem_type}",
                attributes={"element-type": elem_type, "data-type": FlowDataType.TEXT},
            ),
        ]

        handler = UnifiedStreamingTestCallbackHandler(verbose=False)
        handler.mock(mock_data)
        parser = XMLStreamParser()

        await parser.run(handler)

        # Collect parsed data
        parsed_data = []
        async for flow_data in parser:
            parsed_data.append(flow_data)

        non_end_elements = [fd for fd in parsed_data if fd.attributes.get("element-type") != "end"]

        # Should consolidate into 1 element
        assert len(non_end_elements) == 1, f"{elem_type} should consolidate, got {len(non_end_elements)} elements"

        # Verify content was concatenated
        expected = f"Part 1 of {elem_type} Part 2 of {elem_type} Part 3 of {elem_type}"
        assert non_end_elements[0].flow_value == expected, f"Content mismatch for {elem_type}"

        print(f"   ✓ {elem_type}: 3 elements → 1 consolidated element")

    print(f"\n✅ All {len(streamable_types)} streamable types consolidate correctly!")


async def test_non_streamable_types_remain_separate():
    """Verify non-streamable types don't consolidate."""

    # Test types that should NOT consolidate
    non_streamable_types = [
        FlowElementType.STATUS,
        FlowElementType.ERROR,
        FlowElementType.RESULT,
        FlowElementType.FOCUS,
    ]

    print(f"\n📋 Testing {len(non_streamable_types)} non-streamable element types:")

    for elem_type in non_streamable_types:
        # Create multiple elements of the same type
        mock_data = [
            FlowData(
                flow_value=f"Instance 1 of {elem_type}",
                attributes={"element-type": elem_type, "data-type": FlowDataType.TEXT},
            ),
            FlowData(
                flow_value=f"Instance 2 of {elem_type}",
                attributes={"element-type": elem_type, "data-type": FlowDataType.TEXT},
            ),
        ]

        handler = UnifiedStreamingTestCallbackHandler(verbose=False)
        handler.mock(mock_data)
        parser = XMLStreamParser()

        await parser.run(handler)

        # Collect parsed data
        parsed_data = []
        async for flow_data in parser:
            parsed_data.append(flow_data)

        non_end_elements = [fd for fd in parsed_data if fd.attributes.get("element-type") != "end"]

        # Should remain separate
        assert len(non_end_elements) == 2, f"{elem_type} should NOT consolidate, got {len(non_end_elements)} elements"

        print(f"   ✓ {elem_type}: 2 elements → 2 separate elements (correct)")

    print(f"\n✅ All {len(non_streamable_types)} non-streamable types remain separate!")


# Run tests if executed directly
if __name__ == "__main__":
    asyncio.run(test_streaming_bandwidth_optimization())
    asyncio.run(test_streamable_types_coverage())
    asyncio.run(test_non_streamable_types_remain_separate())
    print("\n🎉 All optimization tests passed!")
