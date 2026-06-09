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
Pre-upgrade-path builds appended framed lines onto such legacy files without
a header ("chimera" files: raw prefix + framed tail), which the first-byte
sniff tainted as v0 forever — permanently disabling replay for that shell.
Both sides now recover: ``read_frames`` salvages the contiguous framed tail
(from its first resize frame, where size becomes known), and the writer
upgrades a legacy file in place before its first append so new frames land
in a proper v1 file. The raw legacy prefix is dropped on upgrade — it has no
recorded size, so it was never replayable (the frontend skips v0 streams).

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
                if self._size:
                    self._upgrade_legacy_in_place()
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

    def _upgrade_legacy_in_place(self) -> None:
        """One-time rewrite of a pre-framing (or chimera) file to framed v1.

        Runs before the first append of this instance, so framed frames never
        land headerless on a legacy file (the chimera that taints the whole
        file as v0 and disables replay). A salvageable framed tail (appended
        by a pre-upgrade-path build) is retained; the raw legacy prefix is
        dropped — without a recorded size it was never replayable anyway.
        Called under ``self._lock`` with ``self._size`` freshly stat'ed.
        """
        with open(self._path, "rb") as f:
            if f.read(1) == b"{":
                return  # already framed
        raw = self._path.read_bytes()
        salvaged = self._salvage_framed_tail(raw)
        if salvaged is not None:
            events, (cols, rows) = salvaged
            body = b"".join(json.dumps(e).encode() + b"\n" for e in events)
        else:
            events, (cols, rows), body = [], (self._cols, self._rows), b""
        new_raw = json.dumps({"v": 1, "cols": cols, "rows": rows}).encode() + b"\n" + body
        self._path.write_bytes(new_raw)
        self._size = len(new_raw)

    @staticmethod
    def _salvage_framed_tail(raw: bytes) -> tuple[list, tuple[int, int]] | None:
        """Recover the contiguous framed suffix of a legacy-prefixed file.

        Pre-upgrade-path builds appended framed JSONL lines onto raw legacy
        files. Walk lines from the END while they parse as frames (the framed
        tail is a contiguous suffix; raw bytes at the boundary fail to parse),
        then retain from the first resize frame onward — output before it has
        no known winsize, and replaying at a guessed width garbles. Returns
        ``(events, (cols, rows) at the first retained frame)`` or ``None``
        when nothing faithfully replayable is recoverable.
        """
        lines = raw.split(b"\n")
        frames: list = []
        skipped_torn = False
        for line in reversed(lines):
            if not line:
                if frames:
                    break  # blank line inside raw region — stop
                continue  # trailing split artifact
            try:
                frame = json.loads(line)
            except ValueError:
                # Tolerate one torn final line (crash mid-append), same as
                # the framed reader; any earlier parse failure is raw bytes.
                if frames or skipped_torn:
                    break
                skipped_torn = True
                continue
            if not (isinstance(frame, list) and len(frame) in (2, 3) and frame[0] in ("o", "r")):
                break
            frames.append(frame)
        frames.reverse()
        for i, frame in enumerate(frames):
            if frame[0] == "r":
                try:
                    cols, rows = int(frame[1][0]), int(frame[1][1])
                except (TypeError, ValueError, IndexError):
                    continue
                return frames[i:], (cols, rows)
        return None  # no resize frame — size unknown for the whole tail

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
        ``cols``/``rows`` of None (size unknown — recorded before framing) —
        unless a framed tail appended by a pre-upgrade-path build can be
        salvaged, in which case that tail is surfaced as v1 (replayable).
        A torn final line (crash mid-write) is dropped silently.
        """
        if not self._path.exists():
            return None
        raw = self._path.read_bytes()
        if not raw:
            return None
        if raw[:1] != b"{":
            # Legacy raw-bytes file from before the framed format. Chimera
            # files (raw prefix + headerless framed tail) yield their tail.
            salvaged = self._salvage_framed_tail(raw)
            if salvaged is not None:
                events, (cols, rows) = salvaged
                return {"v": 1, "cols": cols, "rows": rows, "events": events}
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

    def max_seq(self) -> int:
        """Highest output-frame seq persisted in the file (0 if none).

        Used at PTY (re)spawn to resume the session's seq counter past the
        previous server process's epoch: seqs must stay MONOTONIC within one
        stream file or the frontend's replay-vs-live dedup (``chunk.seq <=
        replay.lastSeq``) wrongly drops post-restart output — the terminal
        looks dead after a server restart.
        """
        frames = self.read_frames()
        if frames is None:
            return 0
        return max(
            (e[2] for e in frames["events"] if e[0] == "o" and len(e) > 2 and isinstance(e[2], int)),
            default=0,
        )

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
