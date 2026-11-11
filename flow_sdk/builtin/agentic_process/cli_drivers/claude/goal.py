"""Has the session's ``/goal`` been met? Read from Claude's transcript.

Claude Code writes an ``attachment`` of type ``goal_status`` each time it judges
the goal; the newest non-sentinel one is the verdict. Same offset / held-back
partial line idea as ``AgentTranscriptFile._read_and_fold``, minus the parsing:
only lines naming ``goal_status`` are decoded.
"""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.transcript_analyzer.worker_status import _TAIL_MAX_BYTES

_MAX_ENTRIES = 4096
# path -> (bytes read, latest verdict); each call reads only what was appended.
_seen: dict[str, tuple[int, bool]] = {}


def goal_met(path: Path) -> bool:
    key = str(path)
    try:
        size = path.stat().st_size
    except OSError:
        return False
    offset, met = _seen.get(key, (-1, False))
    if offset == size:
        return met
    cold = offset < 0 or size < offset
    if cold:
        # First look (or rewritten): the newest verdict is near the end; a cold
        # read never pulls a whole long transcript onto the request thread.
        offset, met = max(0, size - _TAIL_MAX_BYTES), False
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read(size - offset)
    except OSError:
        return False
    if cold and offset:
        data = data[data.find(b"\n") + 1 :]  # drop the line the window cut
        offset = size - len(data)
    end = data.rfind(b"\n") + 1  # a half-written last line waits for next time
    if b'"goal_status"' in data:
        for line in data[:end].splitlines():
            if b'"goal_status"' not in line:
                continue
            try:
                att = json.loads(line).get("attachment") or {}
            except ValueError:
                continue
            if att.get("type") == "goal_status" and not att.get("sentinel"):
                met = att.get("met") is True
    if key not in _seen and len(_seen) >= _MAX_ENTRIES:
        _seen.pop(next(iter(_seen)))
    _seen[key] = (offset + end, met)
    return met
