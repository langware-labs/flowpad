"""TranscriptCursorStore — persisted per-file consumption state for the
transcript streamer.

Maps transcript JSONL path → ``(size, mtime_ns)`` captured the last time the
streamer fully consumed the file. The startup catch-up walk consults it to
skip files that haven't changed since they were last consumed. Without it the
registry's offsets are in-memory only, so every fresh process re-parsed the
user's entire CLI history (thousands of JSONLs) from byte 0 on boot.

Persistence is best-effort: ``update()`` marks the store dirty in memory and
``flush()`` writes the whole map atomically (tmp + rename). A lost flush
costs only a re-parse of recently-active files on the next boot —
subscribers are idempotent, so over-delivery is safe. ``flush()`` does
synchronous I/O; call it via ``asyncio.to_thread`` from async code.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

_log = logging.getLogger(__name__)


class TranscriptCursorStore:
    """Dirty-tracked ``path → (size, mtime_ns)`` map backed by one JSON file."""

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._cursors: dict[str, tuple[int, int]] = {}
        self._dirty = False
        self._load()

    def _load(self) -> None:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            self._cursors = {
                str(k): (int(v[0]), int(v[1]))
                for k, v in raw.items()
            }
        except FileNotFoundError:
            pass
        except Exception as exc:
            # Corrupt store — start empty; the next catch-up re-parses and rebuilds it.
            _log.warning("transcript cursors: failed to load %s (%s); starting empty", self._path, exc)
            self._cursors = {}

    def is_consumed(self, file: Path, *, size: int, mtime_ns: int) -> bool:
        """True when the file is byte-identical to the state last consumed."""
        return self._cursors.get(str(file)) == (size, mtime_ns)

    def update(self, file: Path, *, size: int, mtime_ns: int) -> None:
        key = str(file)
        value = (size, mtime_ns)
        if self._cursors.get(key) != value:
            self._cursors[key] = value
            self._dirty = True

    def flush(self) -> None:
        """Atomic write-if-dirty. Synchronous — run via ``asyncio.to_thread``."""
        if not self._dirty:
            return
        self._dirty = False
        snapshot = {k: list(v) for k, v in self._cursors.items()}
        try:
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps(snapshot), encoding="utf-8")
            tmp.replace(self._path)
        except OSError as exc:
            self._dirty = True
            _log.warning("transcript cursors: flush to %s failed: %s", self._path, exc)

    def __len__(self) -> int:
        return len(self._cursors)
