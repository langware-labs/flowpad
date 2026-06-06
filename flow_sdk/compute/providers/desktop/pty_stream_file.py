"""PTY Stream File - Framed rolling buffer for PTY output persistence.

Persists PTY output to disk as a framed JSONL file (.pty) so that a client
can faithfully REPLAY the session after reattach (page refresh / server
restart). Faithful replay requires two things the old raw-byte format could
not provide (validated by the replay-equivalence fuzz matrix in
tests/pty_fuzz/):

1. **Resize events at their exact stream positions.** PTY output is
   calibrated to the winsize in effect when it was emitted; replaying bytes
   at any other width garbles cursor-relative repaints (ink/Claude TUIs).
   Every actual winsize change — including the attach-time repaint jiggle —
   is recorded as a frame.
2. **Frame-boundary truncation.** The rolling cap drops whole frames from
   the front (never splitting an escape sequence mid-byte) and rewrites the
   header so it reflects the winsize in effect at the first retained frame.

File format (JSONL, one JSON value per line):

    {"v": 1, "cols": 100, "rows": 30}      # header: format version + size
    ["o", "<base64 output chunk>", 42]      # output frame (one PTY read) + seq
    ["r", [80, 24]]                         # resize frame (cols, rows)

Legacy files (raw bytes, pre-framing) are detected by a non-``{`` first byte
and surfaced as a single output frame with an unknown (``None``) size.

Output frames are written from the PTY read thread; resize frames from the
event loop. A small lock keeps concurrent appends from tearing lines.
"""

from __future__ import annotations

import base64
import json
import threading
from pathlib import Path

# Truncate down to this fraction of max when the cap is exceeded, so the
# (read + rewrite) compaction amortizes instead of running on every write.
_TRUNCATE_TO_FRACTION = 0.75


class PtyStreamFile:
    """Framed rolling buffer persisting PTY output + resize events to disk.

    Args:
        path: Filesystem path for the .pty file.
        cols/rows: Initial terminal size (header of a fresh file).
        max_size_bytes: Maximum file size before frame-boundary truncation
            (default 10 MB on-disk, i.e. ~7.5 MB of raw output after base64).
    """

    def __init__(
        self,
        path: Path,
        cols: int = 80,
        rows: int = 24,
        max_size_bytes: int = 10 * 1024 * 1024,
    ) -> None:
        self._path = path
        self._max_size_bytes = max_size_bytes
        self._cols = cols
        self._rows = rows
        self._lock = threading.Lock()
        # Cached on-disk size — writes are append-only through this instance,
        # so one stat at first use replaces a stat per PTY chunk (hot path).
        self._size: int | None = None

    # ── writing ──────────────────────────────────────────────────────────────

    def write(self, data: bytes, seq: int | None = None) -> None:
        """Append an output frame. Creates the file (with header) on first write.

        ``seq`` is the per-session output counter — recorded so a replaying
        client can dedup frames against live WS chunks (which carry the same
        seq) without double-applying output.
        """
        if not data:
            return
        frame = ["o", base64.b64encode(data).decode("ascii")]
        if seq is not None:
            frame.append(seq)
        self._append_line(json.dumps(frame))

    def write_resize(self, cols: int, rows: int) -> None:
        """Append a resize frame. Every actual winsize change must be recorded —
        including repaint-jiggle flips — or replay interprets subsequent output
        at the wrong width."""
        self._append_line(json.dumps(["r", [cols, rows]]))

    def _append_line(self, line: str) -> None:
        with self._lock:
            if self._size is None:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                self._size = self._path.stat().st_size if self._path.exists() else 0
            payload = (line + "\n").encode()
            if self._size == 0:
                payload = (
                    json.dumps({"v": 1, "cols": self._cols, "rows": self._rows}) + "\n"
                ).encode() + payload
            with open(self._path, "ab") as f:
                f.write(payload)
            self._size += len(payload)

            if self._size > self._max_size_bytes:
                self._truncate_front()

    def _truncate_front(self) -> None:
        """Drop whole frames from the front until under the compaction target.

        The header is rewritten to the winsize in effect at the first retained
        frame (tracked through any dropped resize frames).
        """
        target = int(self._max_size_bytes * _TRUNCATE_TO_FRACTION)
        raw = self._path.read_bytes()
        lines = raw.split(b"\n")
        # lines[0] is the header; trailing element after final \n is b""
        header = self._parse_header(lines[0])
        cols, rows = header["cols"], header["rows"]

        size = len(raw)
        drop = 1  # index of first retained frame line (0 is the header)
        while drop < len(lines) - 1 and size > target:
            line = lines[drop]
            try:
                frame = json.loads(line)
                if frame[0] == "r":
                    cols, rows = int(frame[1][0]), int(frame[1][1])
            except (ValueError, IndexError, TypeError):
                pass  # malformed line (e.g. torn tail) — drop it
            size -= len(line) + 1
            drop += 1

        new_header = json.dumps({"v": 1, "cols": cols, "rows": rows}).encode()
        new_raw = new_header + b"\n" + b"\n".join(lines[drop:])
        self._path.write_bytes(new_raw)
        self._size = len(new_raw)

    # ── reading ──────────────────────────────────────────────────────────────

    def read_frames(self) -> dict | None:
        """Return ``{"v", "cols", "rows", "events"}`` or None if no file.

        ``events`` is a list of ``["o", b64]`` / ``["r", [cols, rows]]`` frames.
        Legacy raw files are surfaced as v0 with a single output frame and
        ``cols``/``rows`` of None (size unknown — recorded before framing).
        A torn final line (crash mid-write) is dropped silently.
        """
        if not self._path.exists():
            return None
        raw = self._path.read_bytes()
        if not raw:
            return None
        if raw[:1] != b"{":
            # Legacy raw-bytes file from before the framed format.
            return {
                "v": 0,
                "cols": None,
                "rows": None,
                "events": [["o", base64.b64encode(raw).decode("ascii")]],
            }
        lines = raw.split(b"\n")
        header = self._parse_header(lines[0])
        events = []
        for line in lines[1:]:
            if not line:
                continue
            try:
                frame = json.loads(line)
            except ValueError:
                continue  # torn tail line
            if isinstance(frame, list) and len(frame) in (2, 3) and frame[0] in ("o", "r"):
                events.append(frame)
        return {"v": header["v"], "cols": header["cols"], "rows": header["rows"], "events": events}

    def read_all(self) -> bytes:
        """Concatenated raw output bytes (resize frames excluded), or ``b""``.

        Kept for forensics/tests; replay consumers should use ``read_frames``.
        """
        frames = self.read_frames()
        if frames is None:
            return b""
        return b"".join(
            base64.b64decode(ev[1]) for ev in frames["events"] if ev[0] == "o"
        )

    @staticmethod
    def _parse_header(line: bytes) -> dict:
        try:
            h = json.loads(line)
            return {"v": int(h.get("v", 1)), "cols": h.get("cols"), "rows": h.get("rows")}
        except ValueError:
            return {"v": 1, "cols": None, "rows": None}

    # ── lifecycle ────────────────────────────────────────────────────────────

    def delete(self) -> None:
        """Remove the stream file if it exists."""
        self._path.unlink(missing_ok=True)
        self._size = None

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
