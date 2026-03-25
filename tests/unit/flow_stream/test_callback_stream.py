"""
Unit tests for UnifiedStreamingTestCallbackHandler XML streaming functionality.

Tests the callback handler's ability to:
1. Convert FlowData into XML streams
2. Consolidate consecutive same-type elements
3. Handle different element types and data types
4. Process mock data correctly
5. Stream XML through async iteration
"""

import asyncio

import pytest

from flow_sdk.core.flow.models.flow_data import FlowData, FlowDataType, FlowElementType
from flow_sdk.core.flow.streaming.response_handler import StreamingResponseHandler
from tests.flow_test_utils import UnifiedStreamingTestCallbackHandler, XMLStreamParser


async def test_simple_single_element_stream():
    """Test 1: Simple single element - basic chat streaming."""
    # Create callback handler
    handler = UnifiedStreamingTestCallbackHandler(verbose=True)

    # Create simple mock data
    mock_data = [
        FlowData(
            flow_value="Hello, World!",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="How are you?", attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT}
        ),
    ]

    # Inject mock data
    handler.mock(mock_data)

    # Collect flow data
    await asyncio.sleep(0.1)  # Let handler process

    assert handler.completed, "Handler should be marked as completed"
    assert len(handler.flow_data_list) == 2, f"Expected 2 flow data items, got {len(handler.flow_data_list)}"


async def test_multiple_same_type_immediate_streaming():
    """Test 2: Multiple same-type elements should stream immediately (no consolidation)."""
    handler = UnifiedStreamingTestCallbackHandler(verbose=True)

    # Create multiple chat elements of the same type
    mock_data = [
        FlowData(
            flow_value="First part ", attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT}
        ),
        FlowData(
            flow_value="second part ", attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT}
        ),
        FlowData(
            flow_value="status update",
            attributes={"element-type": FlowElementType.STATUS, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="third part.", attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT}
        ),
    ]

    # Inject mock data
    handler.mock(mock_data)

    # Wait for processing
    await asyncio.sleep(0.1)

    assert len(handler.flow_data_list) == 4, f"Expected 4 flow data items, got {len(handler.flow_data_list)}"


async def test_different_element_types_separate():
    """Test 3: Different element types should produce separate XML elements."""
    handler = UnifiedStreamingTestCallbackHandler(verbose=True)

    original_data = [
        FlowData(
            flow_value="Status: Starting process",
            attributes={"element-type": FlowElementType.STATUS, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="Processing data...",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="Error: File not found",
            attributes={"element-type": FlowElementType.ERROR, "data-type": FlowDataType.TEXT},
        ),
    ]

    handler.mock(original_data)

    # Wait for processing
    await asyncio.sleep(0.1)

    # Verify all three elements are preserved separately
    assert len(handler.flow_data_list) == 3, f"Expected 3 separate elements, got {len(handler.flow_data_list)}"

    # Verify element types
    assert handler.flow_data_list[0].attributes.get("element-type") == FlowElementType.STATUS
    assert handler.flow_data_list[1].attributes.get("element-type") == FlowElementType.CHAT
    assert handler.flow_data_list[2].attributes.get("element-type") == FlowElementType.ERROR


async def test_mixed_data_types_and_attributes():
    """Test 4: Complex scenario with mixed data types and custom attributes."""
    handler = UnifiedStreamingTestCallbackHandler(verbose=True)

    original_data = [
        # Text status
        FlowData(
            flow_value="Starting analysis",
            attributes={"element-type": FlowElementType.STATUS, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="ending soon...",
            attributes={"element-type": FlowElementType.STATUS, "data-type": FlowDataType.TEXT},
        ),
        # Object data
        FlowData(
            flow_value={"result": "success", "count": 42},
            attributes={"element-type": FlowElementType.RESULT, "data-type": FlowDataType.OBJECT, "source": "analyzer"},
        ),
        # Another object with same type
        FlowData(
            flow_value={"additional": "data", "items": [1, 2, 3]},
            attributes={
                "element-type": FlowElementType.RESULT,
                "data-type": FlowDataType.OBJECT,
                "source": "processor",
            },
        ),
        # Different element type
        FlowData(
            flow_value="Analysis complete",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
    ]

    handler.mock(original_data)

    # Wait for processing
    await asyncio.sleep(0.1)

    assert len(handler.flow_data_list) == 5, f"Expected 5 flow data items, got {len(handler.flow_data_list)}"

    # Verify first item is status
    assert handler.flow_data_list[0].attributes.get("element-type") == FlowElementType.STATUS
    assert handler.flow_data_list[0].flow_value == "Starting analysis"

    # Verify second status
    assert handler.flow_data_list[1].attributes.get("element-type") == FlowElementType.STATUS
    assert handler.flow_data_list[1].flow_value == "ending soon..."

    # Verify first result
    assert handler.flow_data_list[2].attributes.get("element-type") == FlowElementType.RESULT
    assert handler.flow_data_list[2].flow_value == {"result": "success", "count": 42}

    # Verify second result
    assert handler.flow_data_list[3].attributes.get("element-type") == FlowElementType.RESULT
    assert handler.flow_data_list[3].flow_value == {"additional": "data", "items": [1, 2, 3]}

    # Verify final chat
    assert handler.flow_data_list[4].attributes.get("element-type") == FlowElementType.CHAT


async def test_complex_realistic_flow_scenario():
    """Test 5: Complex realistic scenario with various element types."""
    handler = UnifiedStreamingTestCallbackHandler(verbose=True)

    mock_data = [
        # Initial status messages
        FlowData(
            flow_value="Initializing system",
            attributes={"element-type": FlowElementType.STATUS, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="...loading modules",
            attributes={"element-type": FlowElementType.STATUS, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="...ready", attributes={"element-type": FlowElementType.STATUS, "data-type": FlowDataType.TEXT}
        ),
        # Shell input
        FlowData(
            flow_value="ls -la",
            attributes={
                "element-type": FlowElementType.SHELL_INPUT,
                "data-type": FlowDataType.TEXT,
                "workdir": "/home/user",
            },
        ),
        # Shell output
        FlowData(
            flow_value="total 24\n",
            attributes={"element-type": FlowElementType.SHELL_OUTPUT, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="drwxr-xr-x  3 user user 4096 Jan 1 12:00 .\n",
            attributes={"element-type": FlowElementType.SHELL_OUTPUT, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="drwxr-xr-x 10 user user 4096 Jan 1 11:00 ..\n",
            attributes={"element-type": FlowElementType.SHELL_OUTPUT, "data-type": FlowDataType.TEXT},
        ),
        # Result object
        FlowData(
            flow_value={"files_found": 3, "directories": ["."], "status": "completed"},
            attributes={
                "element-type": FlowElementType.RESULT,
                "data-type": FlowDataType.OBJECT,
                "path": "/home/user",
                "artifact-type": "file-list",
            },
        ),
        # Final chat messages
        FlowData(
            flow_value="Task completed successfully. ",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="Found 3 files in the directory.",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
    ]

    handler.mock(mock_data)

    # Wait for processing
    await asyncio.sleep(0.1)

    # Should have 10 elements
    assert len(handler.flow_data_list) == 10, f"Expected 10 elements, got {len(handler.flow_data_list)}"

    # Verify element types are as expected
    expected_types = [
        FlowElementType.STATUS,
        FlowElementType.STATUS,
        FlowElementType.STATUS,
        FlowElementType.SHELL_INPUT,
        FlowElementType.SHELL_OUTPUT,
        FlowElementType.SHELL_OUTPUT,
        FlowElementType.SHELL_OUTPUT,
        FlowElementType.RESULT,
        FlowElementType.CHAT,
        FlowElementType.CHAT,
    ]

    actual_types = [elem.attributes.get("element-type") for elem in handler.flow_data_list]
    assert actual_types == expected_types, f"Element types mismatch: got {actual_types}, expected {expected_types}"

    # Verify specific elements
    assert handler.flow_data_list[0].flow_value == "Initializing system"
    assert handler.flow_data_list[1].flow_value == "...loading modules"
    assert handler.flow_data_list[2].flow_value == "...ready"
    assert handler.flow_data_list[3].flow_value == "ls -la"
    assert handler.flow_data_list[8].flow_value == "Task completed successfully. "
    assert handler.flow_data_list[9].flow_value == "Found 3 files in the directory."

    assert handler.completed, "Handler should be marked as completed"


async def test_interleaving_reasoning_and_chat():
    """Test 6: Interleaving reasoning and chat elements."""
    handler = UnifiedStreamingTestCallbackHandler(verbose=True)

    mock_data = [
        # Initial reasoning
        FlowData(
            flow_value="Let me think about this problem...",
            attributes={"element-type": FlowElementType.REASONING, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="I need to consider multiple approaches.",
            attributes={"element-type": FlowElementType.REASONING, "data-type": FlowDataType.TEXT},
        ),
        # Switch to chat
        FlowData(
            flow_value="Hello! I'll help you solve this problem.",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value=" Let me start by analyzing your request.",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
        # Back to reasoning
        FlowData(
            flow_value="Actually, let me reconsider the approach...",
            attributes={"element-type": FlowElementType.REASONING, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value="Yes, this alternative method is better.",
            attributes={"element-type": FlowElementType.REASONING, "data-type": FlowDataType.TEXT},
        ),
        # Final chat response
        FlowData(
            flow_value="Based on my analysis,",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
        FlowData(
            flow_value=" here's the solution you need.",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
    ]

    handler.mock(mock_data)

    # Wait for processing
    await asyncio.sleep(0.1)

    # Should have 8 elements
    assert len(handler.flow_data_list) == 8, f"Expected 8 elements, got {len(handler.flow_data_list)}"

    # Verify the alternating pattern
    expected_types = [
        FlowElementType.REASONING,
        FlowElementType.REASONING,
        FlowElementType.CHAT,
        FlowElementType.CHAT,
        FlowElementType.REASONING,
        FlowElementType.REASONING,
        FlowElementType.CHAT,
        FlowElementType.CHAT,
    ]

    actual_types = [elem.attributes.get("element-type") for elem in handler.flow_data_list]
    assert actual_types == expected_types, f"Element types mismatch: got {actual_types}, expected {expected_types}"

    # Verify consolidated chat in each channel
    assert handler.flow_data_list[0].flow_value == "Let me think about this problem..."
    assert handler.flow_data_list[1].flow_value == "I need to consider multiple approaches."
    assert handler.flow_data_list[2].flow_value == "Hello! I'll help you solve this problem."
    assert handler.flow_data_list[3].flow_value == " Let me start by analyzing your request."

    assert handler.completed, "Handler should be marked as completed"


async def test_exception_during_flow_data_handling():
    """Test 7: Exception handling when FlowData causes conversion errors."""
    handler = UnifiedStreamingTestCallbackHandler(verbose=True)

    # Create FlowData that will cause issues
    mock_data = [
        # Valid data first
        FlowData(
            flow_value="This works fine",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
        # Problematic data - object that can't be JSON serialized
        FlowData(
            flow_value=set([1, 2, 3]),  # Sets are not JSON serializable
            attributes={"element-type": FlowElementType.RESULT, "data-type": FlowDataType.OBJECT},
        ),
        # More valid data after the error
        FlowData(
            flow_value="This should still work",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
    ]

    handler.mock(mock_data)

    # Wait for processing
    await asyncio.sleep(0.1)

    # Should handle the error gracefully
    assert len(handler.flow_data_list) >= 2, f"Should have parsed at least 2 valid elements"

    # Verify other elements still work
    assert handler.flow_data_list[0].flow_value == "This works fine"

    assert handler.completed, "Handler should be marked as completed even with errors"


async def test_large_flow_data_streaming():
    """Test 8: Streaming behavior with very large FlowData objects."""
    handler = UnifiedStreamingTestCallbackHandler(verbose=True)

    # Create very large content that could cause memory/performance issues
    large_text = "This is a large content block. " * 1000  # Large text
    large_object = {"large_array": list(range(10000)), "description": "Large object"}

    mock_data = [
        # Large text content
        FlowData(
            flow_value=large_text, attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT}
        ),
        # Large object content
        FlowData(
            flow_value=large_object,
            attributes={"element-type": FlowElementType.RESULT, "data-type": FlowDataType.OBJECT},
        ),
        # Normal content after large content
        FlowData(
            flow_value="Small content after large",
            attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
        ),
    ]

    import time

    start_time = time.time()

    handler.mock(mock_data)

    # Wait for processing
    await asyncio.sleep(0.1)

    processing_time = time.time() - start_time

    # Verify all elements were processed correctly
    assert len(handler.flow_data_list) == 3, f"Should have 3 elements (chat, result, chat), got {len(handler.flow_data_list)}"

    # Verify large content was preserved
    assert len(handler.flow_data_list[0].flow_value) > 10000, "Large text should be preserved"
    assert "large_array" in str(handler.flow_data_list[1].flow_value), "Large object should be preserved"
    assert handler.flow_data_list[2].flow_value == "Small content after large", "Small content should be preserved"

    # Performance check - should complete within reasonable time
    assert processing_time < 5.0, f"Processing took too long: {processing_time:.3f}s"

    assert handler.completed, "Handler should be marked as completed"


async def test_rapid_channel_switching():
    """Test 9: Rapid switching between reasoning and chat channels."""
    handler = UnifiedStreamingTestCallbackHandler(verbose=True)

    # Create rapid alternating pattern
    mock_data = []
    for i in range(20):  # 20 rapid switches
        if i % 2 == 0:
            mock_data.append(
                FlowData(
                    flow_value=f"Reasoning {i}: thinking step {i}",
                    attributes={"element-type": FlowElementType.REASONING, "data-type": FlowDataType.TEXT},
                )
            )
        else:
            mock_data.append(
                FlowData(
                    flow_value=f"Chat {i}: response step {i}",
                    attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT},
                )
            )

    import time

    start_time = time.time()

    handler.mock(mock_data)

    # Wait for processing
    await asyncio.sleep(0.1)

    processing_time = time.time() - start_time

    # Should have 20 elements (no consolidation due to alternating types)
    assert len(handler.flow_data_list) == 20, f"Should have 20 separate elements, got {len(handler.flow_data_list)}"

    # Verify the alternating pattern is preserved
    for i, elem in enumerate(handler.flow_data_list):
        expected_type = FlowElementType.REASONING if i % 2 == 0 else FlowElementType.CHAT
        actual_type = elem.attributes.get("element-type")
        assert actual_type == expected_type, f"Element {i} should be {expected_type}, got {actual_type}"

    # Performance check - rapid switching should still be fast
    assert processing_time < 5.0, f"Processing took too long: {processing_time:.3f}s"

    assert handler.completed, "Handler should be marked as completed"


async def test_special_characters_in_attributes():
    """Test 5: Special characters in attributes don't break XML generation."""
    handler = StreamingResponseHandler()

    # Test data with various special characters in attributes
    test_cases = [
        {
            "name": "quotes",
            "data": FlowData(
                flow_value="Content with quotes",
                attributes={
                    "element-type": FlowElementType.CHAT,
                    "data-type": FlowDataType.TEXT,
                    "user": 'John "The Coder" Doe',
                    "message": "He said 'hello world'",
                },
            ),
        },
        {
            "name": "ampersands",
            "data": FlowData(
                flow_value="Content with ampersands",
                attributes={
                    "element-type": FlowElementType.REASONING,
                    "data-type": FlowDataType.TEXT,
                    "company": "Smith & Jones LLC",
                    "formula": "x & y && z",
                },
            ),
        },
        {
            "name": "angle_brackets",
            "data": FlowData(
                flow_value="Content with brackets",
                attributes={
                    "element-type": FlowElementType.CHAT,
                    "data-type": FlowDataType.TEXT,
                    "comparison": "x < y > z",
                    "html": "<div>test</div>",
                },
            ),
        },
        {
            "name": "unicode_special",
            "data": FlowData(
                flow_value="Content with unicode",
                attributes={
                    "element-type": FlowElementType.REASONING,
                    "data-type": FlowDataType.TEXT,
                    "unicode": "café résumé naïve 🚀",
                    "symbols": "©®™€£¥",
                },
            ),
        },
    ]

    # Test each case directly without streaming (since we're testing XML generation)
    for i, test_case in enumerate(test_cases):
        try:
            # Generate XML to check formatting
            xml_output = test_case["data"].to_xml

            # Verify XML contains expected content
            assert test_case["data"].flow_value in xml_output, f"Content should be in XML for {test_case['name']}"

            # Verify XML is properly formed (basic check)
            assert "<flow-" in xml_output, f"Should have opening tag for {test_case['name']}"
            assert "</flow-" in xml_output, f"Should have closing tag for {test_case['name']}"

            # Test that special characters don't break XML structure
            assert xml_output.count("<") == xml_output.count(">"), f"Mismatched angle brackets in {test_case['name']}"

        except Exception as e:
            raise AssertionError(f"Special character test '{test_case['name']}' failed: {e}")


# Run tests if executed directly
if __name__ == "__main__":
    asyncio.run(test_simple_single_element_stream())
    asyncio.run(test_different_element_types_separate())
    asyncio.run(test_mixed_data_types_and_attributes())
    asyncio.run(test_complex_realistic_flow_scenario())
    asyncio.run(test_interleaving_reasoning_and_chat())
    print("All tests passed!")
