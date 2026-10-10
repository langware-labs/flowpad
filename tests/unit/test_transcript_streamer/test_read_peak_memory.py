"""AgentTranscriptFile — the first read must not slurp the whole file.

``_read_and_fold`` once did ``f.read()`` → ``.decode()`` → ``.splitlines()``
on the entire delta. On the first read the delta IS the file, so the bytes,
one decoded str (4 bytes per char as soon as any emoji is present) and the
list of lines were all alive at once: a transient peak of ~7x the file size
(168 MB real transcript → 1.18 GB traced peak, 118 MB retained). The read
now iterates the buffered binary file one physical line at a time.

Two guards:

* a ``tracemalloc`` peak bound through the real constructor — the peak above
  what is retained must stay a small fraction of the file size (it was ~4.7x
  the file with the slurp, <0.1x with the line-at-a-time read);
* a line-boundary parity test pinning ``entries`` / ``_line_idx`` /
  ``_byte_offset`` for CRLF, blank, malformed, raw-``\\r`` and unterminated
  lines, so the per-line decode keeps exactly the whole-delta decode's rule.
"""
from __future__ import annotations

import json
import tracemalloc
from pathlib import Path

import pytest

from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

_SID = "00000000-0000-4000-8000-000000000001"


def _user_line(i: int, text: str) -> str:
    return json.dumps({
        "type": "user",
        "sessionId": _SID,
        "uuid": f"u{i}",
        "timestamp": "2026-05-22T00:00:00.000Z",
        "message": {"role": "user", "content": text},
    })


def test_first_read_peak_is_bounded_by_line_not_file(tmp_path: Path) -> None:
    """~4 MB JSONL with one emoji on the first line (which forces a 4-byte/char
    str for anything decoded as a whole). Peak above retained must be well
    under half the file size — the slurp put it at several times the file."""
    p = tmp_path / "big.jsonl"
    body = "x" * 2000
    with p.open("w", encoding="utf-8") as f:
        f.write(_user_line(0, "🙂" + body) + "\n")
        for i in range(1, 2000):
            f.write(_user_line(i, body) + "\n")
    file_size = p.stat().st_size
    assert file_size > 3_000_000

    tracemalloc.start()
    try:
        af = AgentTranscriptFile("claude", p)
        retained, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert len(af.entries) == 2000
    transient = peak - retained
    assert transient < 0.5 * file_size, (
        f"first read held {transient / 1e6:.1f} MB above retained for a "
        f"{file_size / 1e6:.1f} MB file — the whole delta is being materialised"
    )


def test_line_boundaries_match_whole_delta_rule(tmp_path: Path) -> None:
    """Per-line decode keeps the whole-delta ``splitlines()`` rule:

    * ``\\r\\n`` is one line;
    * a blank line is skipped without advancing ``_line_idx``;
    * a malformed line advances ``_line_idx`` and is dropped;
    * a raw ``\\r`` inside a physical line splits it in two pieces (today's
      rule — both halves are malformed JSON and dropped, two idx steps);
    * the unterminated last line is deferred and ``_byte_offset`` stops
      before it.
    """
    p = tmp_path / "edges.jsonl"
    l0 = _user_line(0, "first")
    l1 = _user_line(1, "crlf")
    l2 = _user_line(2, "after-blank")
    raw_cr = '{"type": "user", "a": 1\r"b": 2}'
    tail = _user_line(9, "unterminated")
    data = (
        l0 + "\n"
        + l1 + "\r\n"
        + "\n"
        + "not json\n"
        + l2 + "\n"
        + raw_cr + "\n"
        + tail  # no trailing newline
    ).encode("utf-8")
    p.write_bytes(data)

    af = AgentTranscriptFile("claude", p)

    assert [e.text for e in af.entries] == ["first", "crlf", "after-blank"]
    # l0, l1, "not json", l2, raw_cr piece 1, raw_cr piece 2 → 6 idx steps;
    # the blank line and the deferred tail do not count.
    assert af._line_idx == 6
    assert af._byte_offset == len(data) - len(tail.encode("utf-8"))

    # Completing the tail flushes it as one more line.
    with p.open("ab") as f:
        f.write(b"\n")
    af.parse_delta()
    assert [e.text for e in af.entries][-1] == "unterminated"
    assert af._line_idx == 7
    assert af._byte_offset == len(data) + 1


def test_multibyte_char_straddling_read_buffer_decodes_intact(tmp_path: Path) -> None:
    """A 4-byte emoji positioned to straddle the buffered reader's 8 KiB block
    boundary must decode to the same text as a whole-file decode (binary
    iteration only cuts at b"\\n", never inside a UTF-8 sequence)."""
    p = tmp_path / "straddle.jsonl"
    prefix = '{"type": "user", "sessionId": "%s", "uuid": "u0", "timestamp": "2026-05-22T00:00:00.000Z", "message": {"role": "user", "content": "' % _SID
    # Pad so the emoji's 4 bytes start 2 bytes before an 8 KiB boundary.
    pad = "x" * (8192 - 2 - len(prefix.encode("utf-8")))
    text = pad + "🙂" + "y" * 20
    line = prefix + text + '"}}\n'
    assert line.encode("utf-8").find("🙂".encode("utf-8")) == 8190
    p.write_text(line, encoding="utf-8")

    af = AgentTranscriptFile("claude", p)
    assert len(af.entries) == 1
    assert af.entries[0].text == text
