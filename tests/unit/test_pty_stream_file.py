"""Tests for PtyStreamFile — framed rolling buffer for PTY output + resizes."""

import base64
import json
from pathlib import Path

from flow_sdk.compute.providers.desktop.pty_stream_file import PtyStreamFile


def test_write_and_read(tmp_path: Path):
    """Write 3 chunks, read_all() returns concatenation; frames preserved."""
    f = PtyStreamFile(tmp_path / "session.pty", cols=100, rows=30)
    f.write(b"chunk1")
    f.write(b"chunk2")
    f.write(b"chunk3")
    assert f.read_all() == b"chunk1chunk2chunk3"

    frames = f.read_frames()
    assert frames["v"] == 1
    assert (frames["cols"], frames["rows"]) == (100, 30)
    assert [e[0] for e in frames["events"]] == ["o", "o", "o"]
    assert base64.b64decode(frames["events"][0][1]) == b"chunk1"


def test_resize_frames_interleave(tmp_path: Path):
    """Resize frames land at their exact positions between output frames."""
    f = PtyStreamFile(tmp_path / "session.pty", cols=100, rows=30)
    f.write(b"before")
    f.write_resize(80, 24)
    f.write(b"after")
    f.write_resize(60, 20)

    events = f.read_frames()["events"]
    assert events == [
        ["o", base64.b64encode(b"before").decode()],
        ["r", [80, 24]],
        ["o", base64.b64encode(b"after").decode()],
        ["r", [60, 20]],
    ]
    # resize frames are excluded from raw concatenation
    assert f.read_all() == b"beforeafter"


def test_creates_parent_dirs(tmp_path: Path):
    """Write to nested path, parent directories created."""
    nested = tmp_path / "a" / "b" / "c" / "session.pty"
    f = PtyStreamFile(nested)
    f.write(b"hello")
    assert nested.exists()
    assert f.read_all() == b"hello"


def test_rolling_truncation_at_frame_boundaries(tmp_path: Path):
    """Exceeding the cap drops whole frames from the front; file stays valid
    JSONL and the surviving content is a suffix of what was written."""
    max_size = 64 * 1024
    f = PtyStreamFile(tmp_path / "session.pty", cols=100, rows=30, max_size_bytes=max_size)

    all_data = b""
    for i in range(120):
        chunk = (f"line-{i:04d}-".encode() + bytes([65 + i % 26]) * 1024)
        f.write(chunk)
        all_data += chunk

    assert f.size <= max_size
    survived = f.read_all()
    assert survived  # something retained
    assert all_data.endswith(survived)  # exact frame-suffix, nothing torn
    # every line in the file is valid JSON (no mid-frame cuts)
    raw_lines = (tmp_path / "session.pty").read_bytes().split(b"\n")
    for line in raw_lines:
        if line:
            json.loads(line)


def test_truncation_rewrites_header_to_effective_size(tmp_path: Path):
    """Dropping a resize frame folds its size into the rewritten header."""
    max_size = 8 * 1024
    f = PtyStreamFile(tmp_path / "session.pty", cols=100, rows=30, max_size_bytes=max_size)
    f.write(b"x" * 1024)
    f.write_resize(64, 18)  # this frame will be dropped by truncation
    for _ in range(20):
        f.write(b"y" * 1024)

    frames = f.read_frames()
    assert f.size <= max_size
    # the dropped resize must now be the header size
    assert (frames["cols"], frames["rows"]) == (64, 18)
    assert all(e[0] == "o" for e in frames["events"])


def test_legacy_raw_file_detected(tmp_path: Path):
    """Pre-framing raw .pty files surface as v0 with one output frame."""
    p = tmp_path / "legacy.pty"
    p.write_bytes(b"\x1b[31mlegacy raw bytes\x1b[0m")
    f = PtyStreamFile(p)
    frames = f.read_frames()
    assert frames["v"] == 0
    assert frames["cols"] is None and frames["rows"] is None
    assert base64.b64decode(frames["events"][0][1]) == b"\x1b[31mlegacy raw bytes\x1b[0m"
    assert f.read_all() == b"\x1b[31mlegacy raw bytes\x1b[0m"


def test_torn_tail_line_dropped(tmp_path: Path):
    """A crash mid-write leaves a torn last line — reader drops it silently."""
    f = PtyStreamFile(tmp_path / "session.pty", cols=100, rows=30)
    f.write(b"good frame")
    with open(tmp_path / "session.pty", "ab") as fh:
        fh.write(b'["o", "TORN')  # no newline, invalid b64/json
    frames = f.read_frames()
    assert len(frames["events"]) == 1
    assert f.read_all() == b"good frame"


def test_delete(tmp_path: Path):
    """Write data, delete(), exists returns False, read_all() returns b""."""
    f = PtyStreamFile(tmp_path / "session.pty")
    f.write(b"data")
    assert f.exists is True

    f.delete()
    assert f.exists is False
    assert f.read_all() == b""
    assert f.read_frames() is None


def test_read_nonexistent(tmp_path: Path):
    """read_all() on fresh instance returns b""."""
    f = PtyStreamFile(tmp_path / "nonexistent.pty")
    assert f.read_all() == b""
    assert f.read_frames() is None


def test_empty_write_is_noop(tmp_path: Path):
    """write(b"") does not crash and does not create the file."""
    f = PtyStreamFile(tmp_path / "session.pty")
    f.write(b"")
    assert f.exists is False
