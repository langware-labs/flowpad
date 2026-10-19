"""Incremental Claude title metadata reader, independent of application entities."""
from __future__ import annotations

import json
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from threading import RLock


@dataclass(frozen=True)
class ClaudeTitle:
    title: str
    explicit: bool
    revision: str
    sequence: int


@dataclass
class _Cursor:
    identity: tuple[int, int]
    size: int = 0
    mtime: int = 0
    offset: int = 0
    automatic: ClaudeTitle | None = None
    explicit: ClaudeTitle | None = None


_cursors: OrderedDict[str, _Cursor] = OrderedDict()
_lock = RLock()


def read_claude_title(path: str | Path) -> ClaudeTitle | None:
    """Scan once, then consume complete appended lines; manual names always win.

    Missing files keep the cached last good value. Replacement/truncation starts
    a fresh scan. An incomplete final line remains unread until its newline.
    The bounded cache stores only title metadata, never conversation content.
    """
    path = Path(path).resolve()
    key = str(path)
    with _lock:
        cursor = _cursors.get(key)
        try:
            stat = path.stat()
            identity = (stat.st_dev, stat.st_ino)
            if cursor is None or cursor.identity != identity or stat.st_size < cursor.size or (
                stat.st_size == cursor.size and stat.st_mtime_ns != cursor.mtime
            ):
                cursor = _Cursor(identity)
            with path.open('rb') as stream:
                stream.seek(cursor.offset)
                while line := stream.readline():
                    if not line.endswith(b'\n'):
                        break
                    cursor.offset = stream.tell()
                    # Avoid decoding/allocating huge message envelopes on initial scan.
                    if b'"ai-title"' not in line and b'"custom-title"' not in line:
                        continue
                    try:
                        raw = json.loads(line)
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if not isinstance(raw, dict):
                        continue
                    explicit = raw.get('type') == 'custom-title'
                    title = raw.get('customTitle' if explicit else 'aiTitle')
                    if raw.get('type') not in ('ai-title', 'custom-title') or not isinstance(title, str) or not title.strip():
                        continue
                    value = ClaudeTitle(title, explicit, f'{stat.st_ino}:{cursor.offset}:{title}', stat.st_mtime_ns)
                    if explicit:
                        cursor.explicit = value
                    else:
                        cursor.automatic = value
            cursor.size, cursor.mtime = stat.st_size, stat.st_mtime_ns
            _cursors[key] = cursor
            _cursors.move_to_end(key)
            while len(_cursors) > 256:
                _cursors.popitem(last=False)
        except OSError:
            pass
        return (cursor.explicit or cursor.automatic) if cursor else None
