"""Whether a ``!`` command typed into Claude Code's TUI reached it — read from its transcript.

Claude Code records a shell-mode run as a ``user`` row whose content is
``<bash-input>COMMAND</bash-input>``; a command typed while a turn is running is
queued instead (``{"type": "queue-operation", "operation": "enqueue", "content": "COMMAND"}``)
and runs when the turn ends. Either means the keystrokes landed. Neither, a few
seconds after typing, means the TUI dropped them (Claude 2.1.3xx answers every
``!`` command with a model turn, so a link clicked right after another one can be
typed into a TUI that is mid-answer).
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

_TAIL_BYTES = 256 * 1024
_OPEN, _CLOSE = "<bash-input>", "</bash-input>"


def _row_time(row: dict) -> datetime | None:
    value = row.get("timestamp")
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _same(text: object, command: str) -> bool:
    return isinstance(text, str) and text.strip().lstrip("!").strip() == command.strip()


def shell_command_landed(path: Path, command: str, since: datetime) -> bool:
    """True when *command* was run or queued by Claude Code at or after *since* (aware UTC)."""
    # Claude stamps rows to the millisecond; a row in the same millisecond counts.
    since = since.replace(microsecond=since.microsecond // 1000 * 1000)
    try:
        with open(path, "rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - _TAIL_BYTES))
            tail = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return False
    for line in reversed(tail.splitlines()):
        if _OPEN not in line and '"queue-operation"' not in line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        when = _row_time(row)
        if when is None or when < since:
            continue
        if row.get("type") == "queue-operation":
            if row.get("operation") == "enqueue" and _same(row.get("content"), command):
                return True
            continue
        content = (row.get("message") or {}).get("content") if row.get("type") == "user" else None
        if isinstance(content, str) and content.startswith(_OPEN) and _same(
            content[len(_OPEN) :].split(_CLOSE, 1)[0], command
        ):
            return True
    return False
