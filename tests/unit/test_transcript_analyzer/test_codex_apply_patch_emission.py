"""C2: Codex parser's CUSTOM_TOOL_CALL branch now decomposes ``apply_patch``
into structured ``FileWriteEntry`` / ``FileEditEntry`` instances, one per file
op. Delete ops are skipped in v1 (no FileDeleteEntry class). Non-apply_patch
custom tool calls still emit the generic ``ToolUseEntry`` fallback.

Symmetry rationale: Claude's Write tool emits FileWriteEntry directly; with
this change Codex's apply_patch Add/Update File emits the same shape so
downstream consumers (TranscriptStreamer subscribers, the AP file-op
cross-link) can isinstance-check uniformly.
"""
from __future__ import annotations

import pytest

from flow_sdk.transcript_analyzer.entries import (
    FileEditEntry,
    FileWriteEntry,
    ToolUseEntry,
)
from flow_sdk.transcript_analyzer.formats import TranscriptFormat
from flow_sdk.transcript_analyzer.parsers import get_parser_class

pytestmark = pytest.mark.timeout(30)


def _parser():
    # apply_patch dispatch lives in _parse_response_item (rollout shape).
    cls = get_parser_class("codex", TranscriptFormat.CODEX_ROLLOUT)
    return cls(session_id="00000000-0000-0000-0000-000000000001")


def _custom_tool_call(name: str, input_text: str, call_id: str = "call-1") -> dict:
    """Codex rollout shape: response_item wrapping a custom_tool_call payload."""
    return {
        "type": "response_item",
        "payload": {
            "type": "custom_tool_call",
            "name": name,
            "input": input_text,
            "call_id": call_id,
            "id": "item-1",
        },
        "timestamp": "2026-05-23T00:00:00.000Z",
    }


def test_apply_patch_add_file_emits_file_write():
    parser = _parser()
    patch = (
        "*** Begin Patch\n"
        "*** Add File: docs/hello.md\n"
        "+# Hello\n"
        "+world\n"
        "*** End Patch\n"
    )
    entries = parser.feed(_custom_tool_call("apply_patch", patch), 0)
    assert len(entries) == 1
    e = entries[0]
    assert isinstance(e, FileWriteEntry)
    assert e.path == "docs/hello.md"
    assert e.tool_name == "apply_patch"
    assert e.content == "# Hello\nworld\n"  # trailing newline from patch sentinel
    assert e.bytes_count == len(e.content.encode("utf-8"))
    assert e.is_new is True


def test_apply_patch_update_file_emits_file_edit():
    parser = _parser()
    patch = (
        "*** Begin Patch\n"
        "*** Update File: src/foo.py\n"
        "@@ def hello():\n"
        "-    return 1\n"
        "+    return 2\n"
        "*** End Patch\n"
    )
    entries = parser.feed(_custom_tool_call("apply_patch", patch), 0)
    assert len(entries) == 1
    e = entries[0]
    assert isinstance(e, FileEditEntry)
    assert e.path == "src/foo.py"
    assert e.tool_name == "apply_patch"
    assert len(e.hunks) == 1
    assert "@@" in e.hunks[0]["header"]


def test_apply_patch_multi_file_emits_one_entry_per_file():
    parser = _parser()
    patch = (
        "*** Begin Patch\n"
        "*** Add File: a.md\n"
        "+aaa\n"
        "*** Update File: b.py\n"
        "@@\n"
        "-old\n"
        "+new\n"
        "*** Delete File: c.txt\n"
        "*** End Patch\n"
    )
    entries = parser.feed(_custom_tool_call("apply_patch", patch), 0)
    # Add → FileWriteEntry, Update → FileEditEntry, Delete → skipped (v1).
    assert len(entries) == 2
    by_path = {e.path: e for e in entries}
    assert isinstance(by_path["a.md"], FileWriteEntry)
    assert isinstance(by_path["b.py"], FileEditEntry)
    assert "c.txt" not in by_path
    assert [entry.id for entry in entries] == [
        "item-1:file_op_0",
        "item-1:file_op_1",
    ]
    assert [entry.entry_id for entry in entries] == [
        "item-1:file_op_0",
        "item-1:file_op_1",
    ]
    assert {entry.tool_use_id for entry in entries} == {"call-1"}


def test_apply_patch_multi_file_ids_are_stable_across_reparses():
    """Replay dedup keys on the per-op ids — the same input parsed by a fresh
    parser must mint byte-identical (id, entry_id, tool_use_id) triples."""
    patch = (
        "*** Begin Patch\n"
        "*** Add File: a.md\n"
        "+aaa\n"
        "*** Update File: b.py\n"
        "@@\n"
        "-old\n"
        "+new\n"
        "*** End Patch\n"
    )
    event = _custom_tool_call("apply_patch", patch)

    def triples():
        return [(e.id, e.entry_id, e.tool_use_id) for e in _parser().feed(event, 0)]

    first, second = triples(), triples()
    assert first == second
    # And the per-op ids are distinct within one parse (the D01 defect was
    # both ops sharing one id, letting dedup collapse one away).
    assert len({t[0] for t in first}) == len(first) == 2
    assert len({t[1] for t in first}) == 2


def test_non_apply_patch_custom_tool_still_emits_tool_use_entry():
    """Generic custom tool calls (anything other than apply_patch) keep the
    previous ToolUseEntry behaviour — back-compat."""
    parser = _parser()
    event = _custom_tool_call("my_custom_tool", '{"arg": "value"}')
    entries = parser.feed(event, 0)
    assert len(entries) == 1
    assert isinstance(entries[0], ToolUseEntry)
    assert entries[0].tool_name == "my_custom_tool"
    assert entries[0].tool_input == {"arg": "value"}


def test_apply_patch_empty_payload_falls_back_to_tool_use():
    """An apply_patch with no parseable file ops doesn't drop the event —
    it falls back to ToolUseEntry so the event isn't lost from the transcript."""
    parser = _parser()
    # Just sentinels, no file ops
    patch = "*** Begin Patch\n*** End Patch\n"
    entries = parser.feed(_custom_tool_call("apply_patch", patch), 0)
    assert len(entries) == 1
    assert isinstance(entries[0], ToolUseEntry)
    assert entries[0].tool_name == "apply_patch"
