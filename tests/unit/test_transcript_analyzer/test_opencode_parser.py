"""OpenCodeParser over real captures from opencode 1.18.16.

Fixtures were recorded against OpenRouter/``z-ai/glm-5.2`` with stdout piped and
no TTY — the exact shape FlowPad spawns — then redacted.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.transcript_analyzer import AgentTranscriptFile, TranscriptFormat
from flow_sdk.transcript_analyzer.entries import (
    AssistantMessageEntry,
    ToolResultEntry,
    UnknownEntry,
    UsageEntry,
    UserMessageEntry,
)

_RESOURCES = Path(__file__).resolve().parent.parent / "resources" / "transcripts"


@pytest.fixture
def hello_jsonl() -> Path:
    return _RESOURCES / "opencode_stream_hello.jsonl"


@pytest.fixture
def tool_use_jsonl() -> Path:
    return _RESOURCES / "opencode_stream_tool_use.jsonl"


def _parse(path: Path) -> AgentTranscriptFile:
    return AgentTranscriptFile(
        "opencode", path, transcript_format=TranscriptFormat.OPENCODE_STREAM
    )


def test_hello_parses_with_no_unknown_entries(hello_jsonl):
    parsed = _parse(hello_jsonl)
    assert not [e for e in parsed.entries if isinstance(e, UnknownEntry)]


def test_session_id_captured_from_step_start(hello_jsonl):
    parsed = _parse(hello_jsonl)
    assert parsed.entries[0].session_id.startswith("ses_")


def test_assistant_text_becomes_an_assistant_message(hello_jsonl):
    parsed = _parse(hello_jsonl)
    texts = [e.text for e in parsed.entries if isinstance(e, AssistantMessageEntry) and e.text]
    assert texts and "Hello" in texts[0]


def test_step_finish_yields_usage_dims(hello_jsonl):
    parsed = _parse(hello_jsonl)
    usage = {e.io: e.count for e in parsed.entries if isinstance(e, UsageEntry)}
    # The real capture carried both input and output counts.
    assert usage.get("input", 0) > 0
    assert usage.get("output", 0) > 0


def test_usage_never_carries_vendor_cost(hello_jsonl):
    """USD is derived from tokens by the pricing layer, never reported by the
    worker — opencode's own ``cost`` must not reach a UsageEntry."""
    parsed = _parse(hello_jsonl)
    for entry in parsed.entries:
        if isinstance(entry, UsageEntry):
            assert not hasattr(entry, "cost") or getattr(entry, "cost", None) in (None, 0)


def test_tool_use_splits_into_call_and_result(tool_use_jsonl):
    """One opencode ``tool_use`` event carries the call AND its output.

    The parser must emit both halves keyed on the same call id — asserted at the
    parser, because ``AgentTranscriptFile.entries`` deliberately folds a result
    back into its call (the same contract codex's synthesized pair relies on).
    """
    import json

    from flow_sdk.transcript_analyzer.parsers.opencode import OpenCodeParser

    parser = OpenCodeParser()
    produced: list = []
    for index, line in enumerate(tool_use_jsonl.read_text(encoding="utf-8").splitlines()):
        if line.strip():
            produced.extend(parser.feed(json.loads(line), index))

    results = [e for e in produced if isinstance(e, ToolResultEntry)]
    assert results, "expected tool results from the multi-step capture"
    assert {"write", "read"} & {e.tool_name for e in results}

    call_ids = {
        getattr(e, "tool_use_id", None)
        for e in produced
        if not isinstance(e, ToolResultEntry)
    }
    for result in results:
        assert result.tool_use_id in call_ids


def test_folded_view_merges_the_result_into_its_call(tool_use_jsonl):
    """The folded view is what consumers render: one entry per tool call."""
    parsed = _parse(tool_use_jsonl)
    assert not [e for e in parsed.entries if isinstance(e, ToolResultEntry)]
    tool_names = {getattr(e, "tool_name", "") for e in parsed.entries}
    assert {"write", "read"} <= tool_names


def test_tool_capture_has_no_unknown_entries(tool_use_jsonl):
    parsed = _parse(tool_use_jsonl)
    assert not [e for e in parsed.entries if isinstance(e, UnknownEntry)]


def test_model_is_learned_from_the_synthesized_prompt_line(tmp_path):
    """opencode's stream names no model anywhere, so the worker stamps the
    resolved slug on the user-prompt line (and the store projection carries it
    off the assistant row). Without it every entry parses as ``model=None`` and
    pricing silently falls back to its default table — correct only when the
    configured model happens to BE that default, wrong for every other one.
    """
    path = tmp_path / "tee.jsonl"
    path.write_text(
        '{"type":"flowpad.user_prompt","timestamp":1,"sessionID":"ses_x",'
        '"model":"openrouter/z-ai/glm-4.7-flash","part":{"type":"text","text":"hi"}}\n'
        '{"type":"step_finish","timestamp":3,"sessionID":"ses_x",'
        '"part":{"type":"step-finish","reason":"stop","messageID":"msg_1",'
        '"tokens":{"input":10,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}}}\n',
        encoding="utf-8",
    )
    parsed = _parse(path)
    models = {e.model for e in parsed.entries if isinstance(e, UsageEntry)}
    assert models == {"openrouter/z-ai/glm-4.7-flash"}


def test_usage_without_a_model_still_parses(tmp_path):
    """A transcript recorded before the model was stamped must not break."""
    path = tmp_path / "old.jsonl"
    path.write_text(
        '{"type":"step_finish","timestamp":1,"sessionID":"ses_x",'
        '"part":{"type":"step-finish","reason":"stop","messageID":"msg_1",'
        '"tokens":{"input":5,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}\n',
        encoding="utf-8",
    )
    parsed = _parse(path)
    assert [e for e in parsed.entries if isinstance(e, UsageEntry)]


def test_synthesized_user_prompt_becomes_a_user_message(tmp_path):
    """opencode never prints the user's own message (upstream #29997), so the
    worker writes it into the tee itself. It must parse back as a user turn."""
    path = tmp_path / "tee.jsonl"
    path.write_text(
        '{"type":"flowpad.user_prompt","timestamp":1,"sessionID":"ses_x",'
        '"part":{"type":"text","text":"do the thing"}}\n',
        encoding="utf-8",
    )
    parsed = _parse(path)
    users = [e for e in parsed.entries if isinstance(e, UserMessageEntry)]
    assert [e.text for e in users] == ["do the thing"]


def test_unknown_line_type_survives_as_unknown_not_a_crash(tmp_path):
    path = tmp_path / "novel.jsonl"
    path.write_text(
        '{"type":"totally.novel.future.event","timestamp":1,"sessionID":"ses_x","part":{}}\n',
        encoding="utf-8",
    )
    parsed = _parse(path)  # must not raise
    assert parsed.entries


# ---------------------------------------------------------------------------
# Timestamps. Alone among the four vendors, opencode stamps events with an
# integer epoch-MS (in the stdout stream and in the store's ``time_created``).
# Passing that through as a bare numeric string made every consumer that does
# ``new Date(ts)`` see an Invalid Date — ``PtySyncSession.getRefLines`` raised
# ``RangeError: Invalid time value`` and the error boundary took down the whole
# terminal pane. The entry contract is ISO-8601 for every worker.
# ---------------------------------------------------------------------------


def test_epoch_millis_are_normalised_to_iso():
    from flow_sdk.transcript_analyzer.parsers.opencode import _iso_timestamp

    assert _iso_timestamp(1_700_000_000_000).startswith("2023-11-14T")
    # A JSON round-trip can hand back the same value as a string.
    assert _iso_timestamp("1700000000000") == _iso_timestamp(1_700_000_000_000)


def test_an_already_iso_timestamp_passes_through():
    from flow_sdk.transcript_analyzer.parsers.opencode import _iso_timestamp

    assert _iso_timestamp("2026-08-17T12:00:00+00:00") == "2026-08-17T12:00:00+00:00"


def test_a_missing_timestamp_is_empty_not_epoch_zero():
    from flow_sdk.transcript_analyzer.parsers.opencode import _iso_timestamp

    assert _iso_timestamp(None) == ""
    assert _iso_timestamp("") == ""


def test_parsed_entries_carry_a_parseable_timestamp():
    """The contract every downstream reader depends on, asserted end to end."""
    from datetime import datetime

    from flow_sdk.transcript_analyzer.parsers.opencode import OpenCodeParser

    parser = OpenCodeParser(session_id="ses_x")
    entries = parser.feed(
        {
            "type": "text",
            "timestamp": 1_700_000_000_000,
            "sessionID": "ses_x",
            "part": {"type": "text", "text": "hi"},
        },
        0,
    )
    assert entries
    for entry in entries:
        # Would raise for a bare epoch string — which is exactly what crashed.
        datetime.fromisoformat(entry.timestamp)
