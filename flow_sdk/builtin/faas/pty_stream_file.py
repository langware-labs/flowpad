"""PTY Stream File - Rolling file buffer for PTY output persistence.

Persists PTY output to disk as a rolling buffer file (.pty). Output is
appended on each write. When the file exceeds `max_size_bytes` (default 10MB),
the oldest data is discarded by keeping only the last `max_size_bytes` bytes.

This provides crash-recovery support: if the server restarts, the .pty file
contains recent terminal output that can be replayed to the client. The file
is written from the single-threaded PTY output callback, so no locking is
needed.
"""

from pathlib import Path


class PtyStreamFile:
    """Rolling file buffer for persisting PTY output to disk.

    Appends raw PTY output bytes to a file. When the file exceeds
    ``max_size_bytes``, the file is truncated from the front so that only
    the most recent ``max_size_bytes`` of output are retained.

    The default cap is 10 MB, which is enough to hold a substantial
    amount of terminal history while bounding disk usage per session.

    No file or directory is created until the first ``write()`` call.
    No locking is used — the caller is expected to be a single-threaded
    PTY output callback.

    Args:
        path: Filesystem path for the .pty file.
        max_size_bytes: Maximum file size before truncation (default 10 MB).
    """

    def __init__(self, path: Path, max_size_bytes: int = 10 * 1024 * 1024) -> None:
        self._path = path
        self._max_size_bytes = max_size_bytes

    def write(self, data: bytes) -> None:
        """Append data to the stream file, truncating from front if oversized.

        Creates parent directories on first write.
        """
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._path, "ab") as f:
            f.write(data)

        # Truncate from front if file exceeds max size
        if self._path.stat().st_size > self._max_size_bytes:
            tail = self._path.read_bytes()[-self._max_size_bytes:]
            self._path.write_bytes(tail)

    def read_all(self) -> bytes:
        """Return all bytes in the stream file, or ``b""`` if it doesn't exist."""
        if self._path.exists():
            return self._path.read_bytes()
        return b""

    def delete(self) -> None:
        """Remove the stream file if it exists."""
        self._path.unlink(missing_ok=True)

    @property
    def exists(self) -> bool:
        """Whether the stream file exists on disk."""
        return self._path.exists()

    @property
    def size(self) -> int:
        """Current file size in bytes, or 0 if the file doesn't exist."""
        if self._path.exists():
            return self._path.stat().st_size
        return 0
