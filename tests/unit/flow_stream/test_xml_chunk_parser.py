import pytest

from flow_sdk.core.flow.streaming.xml_chunk_parser import XMLChunkParser


@pytest.fixture
def parser_no_prefix():
    return XMLChunkParser(tag_prefix=None)


@pytest.fixture
def parser_flow_prefix():
    return XMLChunkParser(tag_prefix="flow-")


def assert_events_equal(actual_events, expected_events):
    assert len(actual_events) == len(expected_events), (
        f"Expected {len(expected_events)} events, got {len(actual_events)}"
    )
    for i, actual in enumerate(actual_events):
        expected = expected_events[i]
        assert actual == expected, f"Event {i + 1} mismatch.\nActual: {actual}\nExpected: {expected}"


def test_no_tags_no_prefix(parser_no_prefix):
    chunk = "Just some simple text."
    events = parser_no_prefix.process_chunk(chunk)
    expected = [{"event": "chat", "args": None, "content": "Just some simple text."}]
    assert_events_equal(events, expected)


def test_no_tags_with_prefix(parser_flow_prefix):
    chunk = "Just some simple text with prefix filter."
    events = parser_flow_prefix.process_chunk(chunk)
    expected = [{"event": "chat", "args": None, "content": "Just some simple text with prefix filter."}]
    assert_events_equal(events, expected)


def test_simple_tag_no_prefix(parser_no_prefix):
    events = []
    events.extend(parser_no_prefix.process_chunk("<tag>"))
    events.extend(parser_no_prefix.process_chunk("content"))
    events.extend(parser_no_prefix.process_chunk("</tag>"))
    expected = [
        {"event": "tag", "args": {}, "content": ""},
        {"event": "tag", "args": {}, "content": "content"},
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events, expected)


def test_simple_tag_with_flow_prefix_match(parser_flow_prefix):
    events = []
    events.extend(parser_flow_prefix.process_chunk("<flow-tag>"))
    events.extend(parser_flow_prefix.process_chunk("content"))
    events.extend(parser_flow_prefix.process_chunk("</flow-tag>"))
    expected = [
        {"event": "flow-tag", "args": {}, "content": ""},
        {"event": "flow-tag", "args": {}, "content": "content"},
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events, expected)


def test_simple_tag_with_flow_prefix_no_match(parser_flow_prefix):
    events = []
    events.extend(parser_flow_prefix.process_chunk("<othertag>"))
    events.extend(parser_flow_prefix.process_chunk("content"))
    events.extend(parser_flow_prefix.process_chunk("</othertag>"))
    expected = [
        {"event": "chat", "args": None, "content": "<othertag>"},
        {"event": "chat", "args": None, "content": "content"},
        {"event": "chat", "args": None, "content": "</othertag>"},
    ]
    assert_events_equal(events, expected)


def test_tag_with_attributes_flow_prefix(parser_flow_prefix):
    chunk = '<flow-data key="value" id="123">Some data</flow-data>'
    events = parser_flow_prefix.process_chunk(chunk)
    expected = [
        {"event": "flow-data", "args": {"key": "value", "id": "123"}, "content": ""},
        {"event": "flow-data", "args": {"key": "value", "id": "123"}, "content": "Some data"},
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events, expected)


def test_nested_tags_flow_prefix(parser_flow_prefix):
    events = []
    events.extend(parser_flow_prefix.process_chunk("<flow-outer>"))
    events.extend(parser_flow_prefix.process_chunk("Outer text <flow-inner>"))
    events.extend(parser_flow_prefix.process_chunk("Inner text"))
    events.extend(parser_flow_prefix.process_chunk("</flow-inner>More outer"))
    events.extend(parser_flow_prefix.process_chunk("</flow-outer>"))

    expected = [
        {"event": "flow-outer", "args": {}, "content": ""},
        {"event": "flow-outer", "args": {}, "content": "Outer text "},
        {"event": "flow-inner", "args": {}, "content": ""},
        {"event": "flow-inner", "args": {}, "content": "Inner text"},
        {"event": "flow-outer", "args": {}, "content": ""},  # Context change back to outer
        {"event": "flow-outer", "args": {}, "content": "More outer"},
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events, expected)


def test_self_closing_tag_flow_prefix_match(parser_flow_prefix):
    chunk = 'Text <flow-input type="text"/> more text'
    events = parser_flow_prefix.process_chunk(chunk)
    expected = [
        {"event": "chat", "args": None, "content": "Text "},
        {"event": "flow-input", "args": {"type": "text"}, "content": ""},  # Self-closing tag event
        # No context change for self-closing in this model, so next content is root
        {"event": "chat", "args": None, "content": " more text"},
    ]
    assert_events_equal(events, expected)


def test_self_closing_tag_flow_prefix_no_match(parser_flow_prefix):
    chunk = 'Text <input type="text"/> more text'
    events = parser_flow_prefix.process_chunk(chunk)
    expected = [
        {"event": "chat", "args": None, "content": 'Text <input type="text"/> more text'},
    ]
    assert_events_equal(events, expected)


# --- Chunking and Partial Content Tests ---


def test_content_split_across_chunks(parser_flow_prefix):
    events = []
    events.extend(parser_flow_prefix.process_chunk("Part 1 of content"))
    events.extend(parser_flow_prefix.process_chunk(" and part 2."))
    expected = [
        {"event": "chat", "args": None, "content": "Part 1 of content"},
        {"event": "chat", "args": None, "content": " and part 2."},
    ]
    assert_events_equal(events, expected)


def test_opening_tag_split_across_chunks(parser_flow_prefix):
    events = []
    events.extend(parser_flow_prefix.process_chunk("Before <flow-ta"))
    events.extend(parser_flow_prefix.process_chunk("g>Content</flow-tag>"))
    expected = [
        {"event": "chat", "args": None, "content": "Before "},
        {"event": "flow-tag", "args": {}, "content": ""},
        {"event": "flow-tag", "args": {}, "content": "Content"},
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events, expected)


def test_closing_tag_split_across_chunks(parser_flow_prefix):
    events = []
    events.extend(parser_flow_prefix.process_chunk("<flow-tag>Content</flow-t"))
    events.extend(parser_flow_prefix.process_chunk("ag>After"))
    expected = [
        {"event": "flow-tag", "args": {}, "content": ""},
        {"event": "flow-tag", "args": {}, "content": "Content"},
        {"event": "chat", "args": None, "content": ""},
        {"event": "chat", "args": None, "content": "After"},
    ]
    assert_events_equal(events, expected)


def test_tag_prefix_split_across_chunks_match(parser_flow_prefix):
    events = []
    events.extend(parser_flow_prefix.process_chunk("Text <fl"))  # Partial prefix
    events.extend(parser_flow_prefix.process_chunk("ow-data>Data</flow-data>"))
    expected = [
        {"event": "chat", "args": None, "content": "Text "},
        {"event": "flow-data", "args": {}, "content": ""},
        {"event": "flow-data", "args": {}, "content": "Data"},
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events, expected)


def test_tag_prefix_split_across_chunks_no_match(parser_flow_prefix):
    events = []
    events.extend(parser_flow_prefix.process_chunk("Text <fl"))  # Partial prefix
    events.extend(parser_flow_prefix.process_chunk("ux-item>Data</flux-item>"))  # Different suffix
    expected = [
        {"event": "chat", "args": None, "content": "Text "},
        {"event": "chat", "args": None, "content": "<flux-item>"},  # Entire non-matching tag as content
        {"event": "chat", "args": None, "content": "Data"},
        {"event": "chat", "args": None, "content": "</flux-item>"},
    ]
    assert_events_equal(events, expected)


def test_tag_attribute_split_across_chunks(parser_flow_prefix):
    events = []
    events.extend(parser_flow_prefix.process_chunk('<flow-config key="val'))
    events.extend(parser_flow_prefix.process_chunk('ue">Settings</flow-config>'))
    expected = [
        {"event": "flow-config", "args": {"key": "value"}, "content": ""},
        {"event": "flow-config", "args": {"key": "value"}, "content": "Settings"},
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events, expected)


def test_multiple_events_in_one_chunk(parser_flow_prefix):
    chunk = (
        "Content before <flow-tag1>Tag1 text</flow-tag1> content between <flow-tag2>Tag2 text</flow-tag2> content after"
    )
    events = parser_flow_prefix.process_chunk(chunk)
    expected = [
        {"event": "chat", "args": None, "content": "Content before "},
        {"event": "flow-tag1", "args": {}, "content": ""},
        {"event": "flow-tag1", "args": {}, "content": "Tag1 text"},
        {"event": "chat", "args": None, "content": ""},
        {"event": "chat", "args": None, "content": " content between "},
        {"event": "flow-tag2", "args": {}, "content": ""},
        {"event": "flow-tag2", "args": {}, "content": "Tag2 text"},
        {"event": "chat", "args": None, "content": ""},
        {"event": "chat", "args": None, "content": " content after"},
    ]
    assert_events_equal(events, expected)


def test_malformed_tag_treated_as_content(parser_flow_prefix):
    # Malformed opening tag
    events1 = parser_flow_prefix.process_chunk("Text <flow data='oops'> more")
    expected1 = [
        {"event": "chat", "args": None, "content": "Text "},
        {"event": "chat", "args": None, "content": "<flow data='oops'>"},  # Treated as content
        {"event": "chat", "args": None, "content": " more"},
    ]
    assert_events_equal(events1, expected1)

    # Malformed closing tag
    parser_flow_prefix.reset()  # Reset for next test
    events2 = parser_flow_prefix.process_chunk("<flow-tag>text</flow data oops>")
    expected2 = [
        {"event": "flow-tag", "args": {}, "content": ""},
        {"event": "flow-tag", "args": {}, "content": "text"},
        {"event": "flow-tag", "args": {}, "content": "</flow data oops>"},  # Treated as content within flow-tag
    ]
    assert_events_equal(events2, expected2)


def test_empty_chunk(parser_flow_prefix):
    events = parser_flow_prefix.process_chunk("")
    assert_events_equal(events, [])  # No events for an empty chunk


def test_only_partial_tag_in_chunk(parser_flow_prefix):
    events = parser_flow_prefix.process_chunk("<flow-partial")
    assert_events_equal(events, [])  # No events, tag is pending
    assert parser_flow_prefix.pending_tag == "<flow-partial"

    events2 = parser_flow_prefix.process_chunk(' attr="val">')
    expected2 = [
        {"event": "flow-partial", "args": {"attr": "val"}, "content": ""},
    ]
    assert_events_equal(events2, expected2)
    assert parser_flow_prefix.pending_tag == ""


def test_content_then_partial_tag(parser_flow_prefix):
    events = parser_flow_prefix.process_chunk("Some initial text <flow-incomp")
    expected = [
        {"event": "chat", "args": None, "content": "Some initial text "},
    ]
    assert_events_equal(events, expected)
    assert parser_flow_prefix.pending_tag == "<flow-incomp"

    events2 = parser_flow_prefix.process_chunk("lete-tag>Content inside</flow-incomplete-tag>")
    expected2 = [
        {"event": "flow-incomplete-tag", "args": {}, "content": ""},
        {"event": "flow-incomplete-tag", "args": {}, "content": "Content inside"},
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events2, expected2)


def test_your_specific_partial_prefix_case(parser_flow_prefix):
    # CHUNK 4/4: '<fl'
    events1 = parser_flow_prefix.process_chunk("I see there's a build error.\n\n<fl")
    expected1 = [
        {"event": "chat", "args": None, "content": "I see there's a build error.\n\n"},
    ]
    assert_events_equal(events1, expected1)
    assert parser_flow_prefix.pending_tag == "<fl"

    # CHUNK 1/8: "ow-code>\nLet's f"
    events2 = parser_flow_prefix.process_chunk("ow-code>\nLet's f")
    expected2 = [
        {"event": "flow-code", "args": {}, "content": ""},
        {"event": "flow-code", "args": {}, "content": "\nLet's f"},
    ]
    assert_events_equal(events2, expected2)
    assert parser_flow_prefix.pending_tag == ""

    # CHUNK 2/8: 'ix the error\n</'
    events3 = parser_flow_prefix.process_chunk("ix the error\n</")
    expected3 = [
        {"event": "flow-code", "args": {}, "content": "ix the error\n"},
    ]
    assert_events_equal(events3, expected3)
    assert parser_flow_prefix.pending_tag == "</"

    # CHUNK 3/8: 'flow-code>\n\n<low' (using 'flo' for a non-match test)
    events4 = parser_flow_prefix.process_chunk("flow-code>\n\n<flo")  # This will complete </flow-code>
    expected4 = [
        {"event": "chat", "args": None, "content": ""},  # from </flow-code>
        {"event": "chat", "args": None, "content": "\n\n"},
    ]
    assert_events_equal(events4, expected4)
    assert parser_flow_prefix.pending_tag == "<flo"  # <flo is pending

    # CHUNK 4/8: 'wer>This should '
    events5 = parser_flow_prefix.process_chunk("wer>This should ")  # This completes <flower>
    expected5 = [
        {"event": "chat", "args": None, "content": "<flower>"},  # <flower> is not flow-prefixed
        {"event": "chat", "args": None, "content": "This should "},
    ]
    assert_events_equal(events5, expected5)
    assert parser_flow_prefix.pending_tag == ""


def test_no_prefix_all_tags_processed(parser_no_prefix):
    chunk = "<tag1>Text1 <tag2 attr='val'>Text2</tag2></tag1>"
    events = parser_no_prefix.process_chunk(chunk)
    expected = [
        {"event": "tag1", "args": {}, "content": ""},
        {"event": "tag1", "args": {}, "content": "Text1 "},
        {"event": "tag2", "args": {"attr": "val"}, "content": ""},
        {"event": "tag2", "args": {"attr": "val"}, "content": "Text2"},
        {"event": "tag1", "args": {}, "content": ""},  # Back to tag1
        {"event": "chat", "args": None, "content": ""},  # Back to chat
    ]
    assert_events_equal(events, expected)


def test_reset_functionality(parser_flow_prefix):
    parser_flow_prefix.process_chunk("<flow-tag>Content")
    assert parser_flow_prefix.current_context == "flow-tag"
    assert parser_flow_prefix.pending_tag == ""  # Assuming content doesn't make it pending

    parser_flow_prefix.reset()
    assert parser_flow_prefix.current_context == "chat"
    assert parser_flow_prefix.current_args is None
    assert parser_flow_prefix.tag_stack == []
    assert parser_flow_prefix.pending_tag == ""

    # Ensure it works after reset
    events = parser_flow_prefix.process_chunk("New text after reset")
    expected = [{"event": "chat", "args": None, "content": "New text after reset"}]
    assert_events_equal(events, expected)


# --- Malformed </parameter></invoke> Pattern Tests ---


def test_malformed_pattern_complete_in_one_chunk(parser_flow_prefix):
    """Test that </parameter></invoke> pattern is detected and treated as closing tag when complete."""
    events = []
    events.extend(parser_flow_prefix.process_chunk('<flow-write path="print_time.py">'))
    events.extend(
        parser_flow_prefix.process_chunk(
            "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n</parameter>\n</invoke>"
        )
    )

    expected = [
        {"event": "flow-write", "args": {"path": "print_time.py"}, "content": ""},
        {
            "event": "flow-write",
            "args": {"path": "print_time.py"},
            "content": "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n",
        },
        {"event": "flow-invoke-error", "args": {"path": "print_time.py"}, "content": ""},  # Malformed pattern detected
        {"event": "chat", "args": None, "content": ""},  # Pattern detected, closes flow-write
    ]
    assert_events_equal(events, expected)
    assert parser_flow_prefix.tag_stack == []


def test_malformed_pattern_split_between_tags(parser_flow_prefix):
    """Test pattern when </parameter> is in one chunk and </invoke> is in the next."""
    events = []
    events.extend(parser_flow_prefix.process_chunk('<flow-write path="print_time.py">'))
    events.extend(
        parser_flow_prefix.process_chunk(
            "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n</parameter>"
        )
    )
    events.extend(parser_flow_prefix.process_chunk("\n</invoke>"))

    expected = [
        {"event": "flow-write", "args": {"path": "print_time.py"}, "content": ""},
        {
            "event": "flow-write",
            "args": {"path": "print_time.py"},
            "content": "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n",
        },
        {"event": "flow-invoke-error", "args": {"path": "print_time.py"}, "content": ""},  # Malformed pattern detected
        {"event": "chat", "args": None, "content": ""},  # Pattern detected, closes flow-write
    ]
    assert_events_equal(events, expected)
    assert parser_flow_prefix.tag_stack == []


def test_malformed_pattern_parameter_split(parser_flow_prefix):
    """Test pattern when </parameter> is split across chunks."""
    events = []
    events.extend(parser_flow_prefix.process_chunk('<flow-write path="print_time.py">'))
    events.extend(
        parser_flow_prefix.process_chunk(
            "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n</para"
        )
    )
    events.extend(parser_flow_prefix.process_chunk("meter>\n</invoke>"))

    expected = [
        {"event": "flow-write", "args": {"path": "print_time.py"}, "content": ""},
        {
            "event": "flow-write",
            "args": {"path": "print_time.py"},
            "content": "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n",
        },
        {"event": "flow-invoke-error", "args": {"path": "print_time.py"}, "content": ""},  # Malformed pattern detected
        {"event": "chat", "args": None, "content": ""},  # Pattern detected, closes flow-write
    ]
    assert_events_equal(events, expected)
    assert parser_flow_prefix.tag_stack == []


def test_malformed_pattern_invoke_split(parser_flow_prefix):
    """Test pattern when </invoke> is split across chunks."""
    events = []
    events.extend(parser_flow_prefix.process_chunk('<flow-write path="print_time.py">'))
    events.extend(
        parser_flow_prefix.process_chunk(
            "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n</parameter>\n</inv"
        )
    )
    events.extend(parser_flow_prefix.process_chunk("oke>"))

    expected = [
        {"event": "flow-write", "args": {"path": "print_time.py"}, "content": ""},
        {
            "event": "flow-write",
            "args": {"path": "print_time.py"},
            "content": "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n",
        },
        {"event": "flow-invoke-error", "args": {"path": "print_time.py"}, "content": ""},  # Malformed pattern detected
        {"event": "chat", "args": None, "content": ""},  # Pattern detected, closes flow-write
    ]
    assert_events_equal(events, expected)
    assert parser_flow_prefix.tag_stack == []


def test_malformed_pattern_both_tags_split(parser_flow_prefix):
    """Test pattern when both </parameter> and </invoke> are split across chunks."""
    events = []
    events.extend(parser_flow_prefix.process_chunk('<flow-write path="print_time.py">'))
    events.extend(
        parser_flow_prefix.process_chunk(
            "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n</para"
        )
    )
    events.extend(parser_flow_prefix.process_chunk("meter>\n</inv"))
    events.extend(parser_flow_prefix.process_chunk("oke>"))

    expected = [
        {"event": "flow-write", "args": {"path": "print_time.py"}, "content": ""},
        {
            "event": "flow-write",
            "args": {"path": "print_time.py"},
            "content": "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n",
        },
        {"event": "flow-invoke-error", "args": {"path": "print_time.py"}, "content": ""},  # Malformed pattern detected
        {"event": "chat", "args": None, "content": ""},  # Pattern detected, closes flow-write
    ]
    assert_events_equal(events, expected)
    assert parser_flow_prefix.tag_stack == []


def test_malformed_pattern_with_whitespace_variations(parser_flow_prefix):
    """Test pattern with different whitespace between tags."""
    # Test with single newline
    parser_flow_prefix.reset()
    events1 = []
    events1.extend(parser_flow_prefix.process_chunk('<flow-write path="test.py">'))
    events1.extend(parser_flow_prefix.process_chunk("content</parameter>\n</invoke>"))
    expected1 = [
        {"event": "flow-write", "args": {"path": "test.py"}, "content": ""},
        {"event": "flow-write", "args": {"path": "test.py"}, "content": "content"},
        {"event": "flow-invoke-error", "args": {"path": "test.py"}, "content": ""},  # Malformed pattern detected
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events1, expected1)

    # Test with multiple newlines
    parser_flow_prefix.reset()
    events2 = []
    events2.extend(parser_flow_prefix.process_chunk('<flow-write path="test.py">'))
    events2.extend(parser_flow_prefix.process_chunk("content</parameter>\n\n</invoke>"))
    expected2 = [
        {"event": "flow-write", "args": {"path": "test.py"}, "content": ""},
        {"event": "flow-write", "args": {"path": "test.py"}, "content": "content"},
        {"event": "flow-invoke-error", "args": {"path": "test.py"}, "content": ""},  # Malformed pattern detected
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events2, expected2)

    # Test with spaces
    parser_flow_prefix.reset()
    events3 = []
    events3.extend(parser_flow_prefix.process_chunk('<flow-write path="test.py">'))
    events3.extend(parser_flow_prefix.process_chunk("content</parameter> </invoke>"))
    expected3 = [
        {"event": "flow-write", "args": {"path": "test.py"}, "content": ""},
        {"event": "flow-write", "args": {"path": "test.py"}, "content": "content"},
        {"event": "flow-invoke-error", "args": {"path": "test.py"}, "content": ""},  # Malformed pattern detected
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events3, expected3)


def test_malformed_pattern_no_prefix(parser_no_prefix):
    """Test that malformed pattern works even without tag prefix."""
    events = []
    events.extend(parser_no_prefix.process_chunk("<tag>"))
    events.extend(parser_no_prefix.process_chunk("content</parameter>\n</invoke>"))
    expected = [
        {"event": "tag", "args": {}, "content": ""},
        {"event": "tag", "args": {}, "content": "content"},
        {"event": "flow-invoke-error", "args": {}, "content": ""},  # Malformed pattern detected
        {"event": "chat", "args": None, "content": ""},  # Pattern closes tag
    ]
    assert_events_equal(events, expected)
    assert parser_no_prefix.tag_stack == []


def test_malformed_pattern_nested_tags(parser_flow_prefix):
    """Test malformed pattern with nested tags."""
    events = []
    events.extend(parser_flow_prefix.process_chunk("<flow-outer>"))
    events.extend(parser_flow_prefix.process_chunk("<flow-inner>"))
    events.extend(parser_flow_prefix.process_chunk("inner content</parameter>\n</invoke>"))

    expected = [
        {"event": "flow-outer", "args": {}, "content": ""},
        {"event": "flow-inner", "args": {}, "content": ""},
        {"event": "flow-inner", "args": {}, "content": "inner content"},  # Content inside flow-inner
        {"event": "flow-invoke-error", "args": {}, "content": ""},  # Malformed pattern detected
        {"event": "flow-outer", "args": {}, "content": ""},  # Pattern closes flow-inner, back to flow-outer
    ]
    assert_events_equal(events, expected)
    assert parser_flow_prefix.tag_stack == [("flow-outer", {})]


def test_malformed_pattern_full_example_split_multiple_ways(parser_flow_prefix):
    """Test the full example with pattern split in different places."""
    # Split 1: After </parameter> tag
    parser_flow_prefix.reset()
    events1 = []
    events1.extend(
        parser_flow_prefix.process_chunk(
            '<flow-write path="print_time.py">\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n</parameter>'
        )
    )
    events1.extend(parser_flow_prefix.process_chunk("\n</invoke>"))
    expected1 = [
        {"event": "flow-write", "args": {"path": "print_time.py"}, "content": ""},
        {
            "event": "flow-write",
            "args": {"path": "print_time.py"},
            "content": "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n",
        },
        {"event": "flow-invoke-error", "args": {"path": "print_time.py"}, "content": ""},  # Malformed pattern detected
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events1, expected1)

    # Split 2: In the middle of </parameter>
    parser_flow_prefix.reset()
    events2 = []
    events2.extend(
        parser_flow_prefix.process_chunk(
            '<flow-write path="print_time.py">\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n</para'
        )
    )
    events2.extend(parser_flow_prefix.process_chunk("meter>\n</invoke>"))
    expected2 = [
        {"event": "flow-write", "args": {"path": "print_time.py"}, "content": ""},
        {
            "event": "flow-write",
            "args": {"path": "print_time.py"},
            "content": "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n",
        },
        {"event": "flow-invoke-error", "args": {"path": "print_time.py"}, "content": ""},  # Malformed pattern detected
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events2, expected2)

    # Split 3: In the middle of </invoke>
    parser_flow_prefix.reset()
    events3 = []
    events3.extend(
        parser_flow_prefix.process_chunk(
            '<flow-write path="print_time.py">\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n</parameter>\n</inv'
        )
    )
    events3.extend(parser_flow_prefix.process_chunk("oke>"))
    expected3 = [
        {"event": "flow-write", "args": {"path": "print_time.py"}, "content": ""},
        {
            "event": "flow-write",
            "args": {"path": "print_time.py"},
            "content": "\nimport time\n\n\ndef print_current_time(duration_seconds=10):\n    return end_time\n",
        },
        {"event": "flow-invoke-error", "args": {"path": "print_time.py"}, "content": ""},  # Malformed pattern detected
        {"event": "chat", "args": None, "content": ""},
    ]
    assert_events_equal(events3, expected3)
