"""Derive a :class:`WorkerStatus` from the tail of a JSONL transcript.

The scan is identical for every vendor that writes an append-only JSONL: stat
the file, decide whether it is still being written, read the last window, walk
it backwards, and hand each parsed object to a vendor ``classify`` callback
until one of them claims it. Only ``classify`` is vendor knowledge, so only
``classify`` lives in the vendor package.

Codex, Copilot and OpenCode each carried this scan. Copilot's and OpenCode's
were byte-identical; codex's spelled the stale-file case as a ``fallback``
variable plus a ``break`` rather than an inline conditional, which produces the
same answer by a longer route.

NOT the same as ``flow_sdk.builtin.worker_status._tail_status``. That one is
claude's, reached by a different call path, and it uses an *expanding* read
(4 KB growing to 2 MB) because a single oversized assistant line can strand the
signal it needs. Do not fold the two together.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable

from flow_sdk.builtin.worker_status import ACTIVE_SECONDS, WorkerStatus

#: How much of the file's tail to read. One window, not an expanding scan — a
#: vendor status line is small and always near the end.
TAIL_BYTES = 64 * 1024

#: ``ACTIVE_SECONDS`` (re-exported from ``worker_status``) — an mtime within
#: that many seconds means the session is still being written. Past it, a
#: non-terminal status is reported as INACTIVE rather than as whatever the last
#: line happened to say. Deliberately the SAME threshold claude uses: two
#: declarations would let the vendors disagree about when a worker goes stale.
#: ``TAIL_BYTES`` is NOT shared — 64 KB here vs claude's 4 KB expanding scan is
#: a real algorithmic difference.

#: ``(parsed_line) -> (status, is_terminal)``. ``status is None`` means "this
#: line says nothing about status, keep walking backwards". ``is_terminal``
#: means the status is final and must be reported even for a stale file.
Classifier = Callable[[dict[str, Any]], "tuple[WorkerStatus | None, bool]"]


def tail_status(
    path: str | Path,
    classify: Classifier,
    *,
    tail_bytes: int = TAIL_BYTES,
    active_seconds: int = ACTIVE_SECONDS,
) -> WorkerStatus:
    """Walk a JSONL transcript's tail backwards and classify the newest signal.

    Returns ``INITIALIZING`` when the file is missing, unreadable, or holds
    nothing parseable — all three mean "no evidence yet", which is different
    from "evidence that nothing is happening".
    """
    file_path = Path(path)
    try:
        stat = file_path.stat()
    except OSError:
        return WorkerStatus.INITIALIZING

    is_active = (time.time() - stat.st_mtime) <= active_seconds
    try:
        size = stat.st_size
        with file_path.open("rb") as handle:
            if size > tail_bytes:
                handle.seek(size - tail_bytes)
            chunk = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return WorkerStatus.INITIALIZING

    saw_parseable = False
    for line in reversed(chunk.splitlines()):
        raw_line = line.strip()
        if not raw_line:
            continue
        try:
            raw = json.loads(raw_line)
        except json.JSONDecodeError:
            # Seeking into the tail can split the first line — skip it rather
            # than treating a truncated object as "nothing parseable".
            continue
        if not isinstance(raw, dict):
            continue
        saw_parseable = True
        status, terminal = classify(raw)
        if status is None:
            continue
        if terminal:
            return status
        # Newest status wins, but only counts as live while the file is fresh.
        return status if is_active else WorkerStatus.INACTIVE

    if not saw_parseable:
        return WorkerStatus.INITIALIZING
    return WorkerStatus.UNKNOWN if is_active else WorkerStatus.INACTIVE
