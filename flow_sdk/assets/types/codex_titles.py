"""Shared incremental reader for Codex's append-only native title index."""
from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from threading import RLock


@dataclass(frozen=True)
class CodexTitle:
    title: str
    revision: str
    sequence: int | None


@dataclass
class _IndexCursor:
    identity: tuple[int, int]
    size: int = 0
    mtime: int = 0
    offset: int = 0
    titles: dict[str, CodexTitle] = field(default_factory=dict)


# A backend normally reads one home. Bound alternate/test home retention while
# keeping just the latest title per session, never historical index records.
_MAX_INDEXES = 16
_indexes: OrderedDict[str, _IndexCursor] = OrderedDict()
_lock = RLock()


def _title_from_line(line: bytes) -> tuple[str, CodexTitle] | None:
    try:
        raw = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    session_id, title = raw.get('id'), raw.get('thread_name')
    if not isinstance(session_id, str) or not session_id or not isinstance(title, str) or not title.strip():
        return None
    sequence = None
    if isinstance(raw.get('updated_at'), str):
        try:
            sequence = int(datetime.fromisoformat(raw['updated_at'].replace('Z', '+00:00')).timestamp() * 1_000_000_000)
        except ValueError:
            pass
    return session_id, CodexTitle(title, hashlib.sha256(line).hexdigest(), sequence)


def read_codex_title(path: str | Path, session_id: str) -> CodexTitle | None:
    """Read each complete native record once, shared by history and observers.

    Unchanged indexes need only a stat and lookup. A partial trailing record is
    left at its starting offset until completed; malformed complete records are
    skipped. Replacement/truncation resets the map. Missing files retain the
    cached last good title, matching the naming FSM's non-downgrade behavior.
    """
    path = Path(path).resolve()
    key = str(path)
    with _lock:
        cursor = _indexes.get(key)
        try:
            stat = path.stat()
            identity = (stat.st_dev, stat.st_ino)
            if cursor is None or cursor.identity != identity or stat.st_size < cursor.size or (
                stat.st_size == cursor.size and stat.st_mtime_ns != cursor.mtime
            ):
                cursor = _IndexCursor(identity)
            if cursor.mtime != stat.st_mtime_ns or cursor.size != stat.st_size:
                with path.open('rb') as stream:
                    stream.seek(cursor.offset)
                    while line := stream.readline():
                        if not line.endswith(b'\n'):
                            break
                        cursor.offset = stream.tell()
                        parsed = _title_from_line(line)
                        if parsed is None:
                            continue
                        sid, candidate = parsed
                        previous = cursor.titles.get(sid)
                        if previous is None or candidate.sequence is None or previous.sequence is None or candidate.sequence >= previous.sequence:
                            cursor.titles[sid] = candidate
                cursor.size, cursor.mtime = stat.st_size, stat.st_mtime_ns
            _indexes[key] = cursor
            _indexes.move_to_end(key)
            while len(_indexes) > _MAX_INDEXES:
                _indexes.popitem(last=False)
        except OSError:
            pass
        return cursor.titles.get(session_id) if cursor else None
