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


def _make_chimera(p: Path, raw: bytes, frames: list) -> None:
    """Simulate a pre-upgrade-path build: framed lines appended headerless
    onto a legacy raw file (the chimera that used to taint replay as v0)."""
    p.write_bytes(raw)
    with open(p, "ab") as fh:
        for frame in frames:
            fh.write(json.dumps(frame).encode() + b"\n")


def test_chimera_read_salvages_framed_tail(tmp_path: Path):
    """Raw legacy prefix + framed tail: read_frames surfaces the tail as v1
    from its first resize frame (where size becomes known), not v0."""
    p = tmp_path / "chimera.pty"
    b64 = base64.b64encode(b"post-upgrade output").decode()
    _make_chimera(
        p,
        b"\x1b7\x1b[r\x1b[?25h raw legacy bytes \x1b[H\nmore raw\n",
        [["o", b64, 7], ["r", [120, 40]], ["o", b64, 8], ["o", b64, 9]],
    )
    f = PtyStreamFile(p)
    frames = f.read_frames()
    assert frames["v"] == 1
    assert (frames["cols"], frames["rows"]) == (120, 40)
    # retained from the first resize frame onward — the sizeless "o" dropped
    assert frames["events"] == [["r", [120, 40]], ["o", b64, 8], ["o", b64, 9]]
    assert f.max_seq() == 9  # seq epoch continues across the salvage


def test_chimera_write_upgrades_in_place(tmp_path: Path):
    """First append to a chimera rewrites it as a proper v1 file: header +
    salvaged tail + the new frame; the raw legacy prefix is dropped.

    The old writer glued its FIRST appended line onto the raw bytes (no
    leading newline) — that frame is unparseable and sacrificed; salvage
    starts at the first clean resize frame.
    """
    p = tmp_path / "chimera.pty"
    b64 = base64.b64encode(b"tail").decode()
    _make_chimera(
        p,
        b"raw legacy \x1b[31mbytes\x1b[0m",  # no trailing newline — glues next line
        [["o", b64, 2], ["r", [90, 25]], ["o", b64, 3]],
    )
    f = PtyStreamFile(p, cols=100, rows=30)
    f.write(b"fresh", seq=4)
    assert p.read_bytes().startswith(b'{"v": 1')
    frames = f.read_frames()
    assert frames["v"] == 1
    assert (frames["cols"], frames["rows"]) == (90, 25)
    assert frames["events"] == [
        ["r", [90, 25]],
        ["o", b64, 3],
        ["o", base64.b64encode(b"fresh").decode(), 4],
    ]
    assert f.read_all() == b"tailfresh"


def test_pure_legacy_write_upgrade_starts_fresh(tmp_path: Path):
    """First append to a pure pre-framing file (no salvageable tail) starts a
    fresh v1 file at the constructor size; the raw bytes are dropped."""
    p = tmp_path / "legacy.pty"
    p.write_bytes(b"\x1b[31mold raw output\x1b[0m")
    f = PtyStreamFile(p, cols=100, rows=30)
    f.write(b"fresh", seq=1)
    frames = f.read_frames()
    assert frames["v"] == 1
    assert (frames["cols"], frames["rows"]) == (100, 30)
    assert frames["events"] == [["o", base64.b64encode(b"fresh").decode(), 1]]


def test_chimera_without_resize_frame_stays_v0(tmp_path: Path):
    """A framed tail with no resize frame has no known size — replaying it at
    a guessed width garbles, so the whole file stays legacy v0."""
    p = tmp_path / "chimera.pty"
    b64 = base64.b64encode(b"tail").decode()
    _make_chimera(p, b"raw legacy bytes", [["o", b64, 1], ["o", b64, 2]])
    frames = PtyStreamFile(p).read_frames()
    assert frames["v"] == 0
    assert frames["cols"] is None and frames["rows"] is None
    assert len(frames["events"]) == 1  # whole blob as one legacy frame


def test_chimera_torn_tail_still_salvaged(tmp_path: Path):
    """A torn final line (crash mid-append) doesn't forfeit the salvage."""
    p = tmp_path / "chimera.pty"
    b64 = base64.b64encode(b"tail").decode()
    _make_chimera(p, b"raw legacy bytes\n", [["r", [80, 24]], ["o", b64, 5]])
    with open(p, "ab") as fh:
        fh.write(b'["o", "TORN')  # no newline, invalid json
    frames = PtyStreamFile(p).read_frames()
    assert frames["v"] == 1
    assert (frames["cols"], frames["rows"]) == (80, 24)
    assert frames["events"] == [["r", [80, 24]], ["o", b64, 5]]


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
