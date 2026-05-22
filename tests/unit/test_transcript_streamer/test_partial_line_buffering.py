"""AgentTranscriptFile.parse_delta — partial-line buffering.

When the underlying JSONL file is written in chunks that don't end on a
newline (rare but possible if FSOp fires mid-write), the parser must NOT
consume the trailing incomplete line. It buffers until the next call when
the newline arrives. Without this, parser.feed would receive truncated JSON
and silently drop the line.

The fix lives in ``_read_and_fold``: ``rfind(b"\\n")`` finds the last
newline; ``_byte_offset`` advances only up to it. The trailing bytes stay
in the file (not consumed) for the next call.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def _line(sid: str, ts: str = "2026-05-22T00:00:00.000Z") -> str:
    return json.dumps({"type": "session_meta", "sessionId": sid, "timestamp": ts})


def test_complete_line_consumed_normally(tmp_path: Path) -> None:
    """Baseline: a line written with trailing newline is parsed on parse_delta."""
    p = tmp_path / "complete.jsonl"
    p.write_text(_line("00000000-0000-0000-0000-000000000001") + "\n")

    af = AgentTranscriptFile("claude", p)
    af.parse_delta()  # flush initial
    assert len(af.entries) == 1


def test_trailing_incomplete_line_is_buffered(tmp_path: Path) -> None:
    """Writing a JSON line WITHOUT trailing newline must NOT be parsed.
    The next write that supplies the newline should flush both."""
    p = tmp_path / "partial.jsonl"
    p.touch()

    af = AgentTranscriptFile("claude", p)
    # No data yet.
    assert af.entries == []

    # First write: complete line.
    with open(p, "ab") as f:
        f.write((_line("00000000-0000-0000-0000-000000000001") + "\n").encode("utf-8"))
    af.parse_delta()
    assert len(af.entries) == 1

    # Second write: partial line (no trailing newline). Parser must NOT pick it up yet.
    partial = _line("00000000-0000-0000-0000-000000000002")
    with open(p, "ab") as f:
        f.write(partial.encode("utf-8"))  # no \n
    af.parse_delta()
    assert len(af.entries) == 1, "incomplete line must be deferred"

    # Third write: the trailing newline. Now the buffered line flushes.
    with open(p, "ab") as f:
        f.write(b"\n")
    af.parse_delta()
    assert len(af.entries) == 2


def test_chunk_ending_mid_line_resilient(tmp_path: Path) -> None:
    """A more adversarial sequence: line is split across two writes with no
    newline in the first. parse_delta is called between writes — must
    eventually produce the line."""
    p = tmp_path / "split.jsonl"
    p.touch()

    af = AgentTranscriptFile("claude", p)
    af.parse_delta()  # 0 entries

    line = _line("00000000-0000-0000-0000-000000000007") + "\n"
    line_bytes = line.encode("utf-8")
    mid = len(line_bytes) // 2

    # First half: no newline yet.
    with open(p, "ab") as f:
        f.write(line_bytes[:mid])
    af.parse_delta()
    assert af.entries == [], "half-written line must not parse"

    # Second half: completes the line.
    with open(p, "ab") as f:
        f.write(line_bytes[mid:])
    af.parse_delta()
    assert len(af.entries) == 1


def test_truncate_resets_state(tmp_path: Path) -> None:
    """If the file shrinks (truncate / rewrite), state resets and we re-parse."""
    p = tmp_path / "truncate.jsonl"
    p.write_text(
        _line("00000000-0000-0000-0000-000000000001") + "\n"
        + _line("00000000-0000-0000-0000-000000000002") + "\n",
        encoding="utf-8",
    )

    af = AgentTranscriptFile("claude", p)
    af.parse_delta()
    assert len(af.entries) == 2

    # Truncate + rewrite with different content.
    p.write_text(_line("00000000-0000-0000-0000-000000000099") + "\n", encoding="utf-8")
    af.parse_delta()
    assert len(af.entries) == 1, "truncate detection should reset state and re-parse"
