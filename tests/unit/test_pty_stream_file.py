"""Tests for PtyStreamFile — rolling file buffer for PTY output."""

from pathlib import Path

from flow_sdk.compute.providers.local.pty_stream_file import PtyStreamFile


def test_write_and_read(tmp_path: Path):
    """Write 3 chunks, read_all() returns concatenation."""
    f = PtyStreamFile(tmp_path / "session.pty")
    f.write(b"chunk1")
    f.write(b"chunk2")
    f.write(b"chunk3")
    assert f.read_all() == b"chunk1chunk2chunk3"


def test_creates_parent_dirs(tmp_path: Path):
    """Write to nested path, parent directories created."""
    nested = tmp_path / "a" / "b" / "c" / "session.pty"
    f = PtyStreamFile(nested)
    f.write(b"hello")
    assert nested.exists()
    assert f.read_all() == b"hello"


def test_rolling_buffer_truncation(tmp_path: Path):
    """Write 12MB (in chunks), verify size <= 10MB and content is last 10MB."""
    max_size = 10 * 1024 * 1024
    f = PtyStreamFile(tmp_path / "session.pty", max_size_bytes=max_size)

    # Write 12MB in 1MB chunks
    chunk_size = 1024 * 1024
    all_data = b""
    for i in range(12):
        chunk = bytes([i % 256]) * chunk_size
        f.write(chunk)
        all_data += chunk

    assert f.size <= max_size
    expected_tail = all_data[-max_size:]
    assert f.read_all() == expected_tail


def test_delete(tmp_path: Path):
    """Write data, delete(), exists returns False, read_all() returns b""."""
    f = PtyStreamFile(tmp_path / "session.pty")
    f.write(b"data")
    assert f.exists is True

    f.delete()
    assert f.exists is False
    assert f.read_all() == b""


def test_read_nonexistent(tmp_path: Path):
    """read_all() on fresh instance returns b""."""
    f = PtyStreamFile(tmp_path / "nonexistent.pty")
    assert f.read_all() == b""


def test_size_property(tmp_path: Path):
    """size returns 0 before write, correct byte count after write."""
    f = PtyStreamFile(tmp_path / "session.pty")
    assert f.size == 0

    f.write(b"hello")
    assert f.size == 5

    f.write(b"world")
    assert f.size == 10


def test_empty_write(tmp_path: Path):
    """write(b"") does not crash."""
    f = PtyStreamFile(tmp_path / "session.pty")
    f.write(b"")
    # File may or may not be created — just verify no crash
