"""AgenticProcessStatus — shared status enum and helpers for Claude session state.

Neutral module with no intra-package imports. Both ClaudeSessionRecord and
AgenticProcessRecord import from here; this breaks the circular dependency that
would arise if the enum lived in either of those modules.
"""

from __future__ import annotations

import json
import time as _time
from pathlib import Path as _Path
from flow_sdk._compat import StrEnum


class AgenticProcessStatus(StrEnum):
    NEW          = "new"          # creation default — never launched

    # No transcript (file-level)
    INIT         = "init"         # launched, never had first prompt / no transcript file yet
    EMPTY        = "empty"        # JSONL exists but has no parseable content

    # Workflow default — no session linked yet
    IDLE         = "idle"         # process created, no Claude session linked

    # Terminal — session ended, cannot resume
    COMPLETE     = "complete"     # finished cleanly (end_turn / last-prompt)
    ERROR        = "error"        # abnormal end (stop_sequence / crash)
    INTERRUPTED  = "interrupted"  # user interrupted (Escape / Ctrl-C)
    INACTIVE     = "inactive"     # stale file >5 min with no terminal signal (assumed dead)

    # Active — transcript-derivable
    WAITING      = "waiting"      # user message received, Claude has not yet responded
    THINKING     = "thinking"     # assistant streaming / generating text
    TOOL_CALL    = "tool_call"    # Claude finished its turn and dispatched tool(s)
    TOOL_RUNNING = "tool_running" # tool is actively executing (progress events)

    # Workflow-level — set by ProcessorState, not transcript-derivable
    RUNNING      = "running"      # generic busy / backward compat
    PAUSED       = "paused"
    STEPPING     = "stepping"


# ---------------------------------------------------------------------------
# Status helper sets
# ---------------------------------------------------------------------------

_RUNNING_STATUSES: frozenset[AgenticProcessStatus] = frozenset({
    AgenticProcessStatus.WAITING,
    AgenticProcessStatus.THINKING,
    AgenticProcessStatus.TOOL_CALL,
    AgenticProcessStatus.TOOL_RUNNING,
    AgenticProcessStatus.RUNNING,
    AgenticProcessStatus.PAUSED,
    AgenticProcessStatus.STEPPING,
})

_BUSY_STATUSES: frozenset[AgenticProcessStatus] = frozenset({
    AgenticProcessStatus.THINKING,
    AgenticProcessStatus.TOOL_CALL,
    AgenticProcessStatus.TOOL_RUNNING,
    AgenticProcessStatus.RUNNING,
})

_TERMINAL_STATUSES: frozenset[AgenticProcessStatus] = frozenset({
    AgenticProcessStatus.COMPLETE,
    AgenticProcessStatus.ERROR,
    AgenticProcessStatus.INTERRUPTED,
    AgenticProcessStatus.INACTIVE,
})


def is_running(status: AgenticProcessStatus) -> bool:
    """True for any active state (WAITING, THINKING, TOOL_CALL, TOOL_RUNNING, RUNNING, PAUSED, STEPPING)."""
    return status in _RUNNING_STATUSES


def is_busy(status: AgenticProcessStatus) -> bool:
    """True when actively processing (THINKING, TOOL_CALL, TOOL_RUNNING, RUNNING). Excludes WAITING/PAUSED/STEPPING."""
    return status in _BUSY_STATUSES


def is_idle(status: AgenticProcessStatus) -> bool:
    """True when not active (INIT, EMPTY, IDLE, COMPLETE, ERROR, INTERRUPTED, INACTIVE)."""
    return status not in _RUNNING_STATUSES


def is_terminal(status: AgenticProcessStatus) -> bool:
    """True when the session has ended and cannot be resumed (COMPLETE, ERROR, INTERRUPTED, INACTIVE)."""
    return status in _TERMINAL_STATUSES


# ---------------------------------------------------------------------------
# _tail_status — fast JSONL tail-read → AgenticProcessStatus
# ---------------------------------------------------------------------------

_TAIL_BYTES = 4096
_ACTIVE_SECONDS = 300  # JSONL mtime within 5 min → session still being written


def _last_user_text(chunk: str) -> str:
    """Extract text content from the last user entry in a JSONL chunk."""
    for line in reversed(chunk.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("type") == "user":
            msg = entry.get("message", {})
            content = msg.get("content", "") if isinstance(msg, dict) else str(msg)
            if isinstance(content, list):
                return " ".join(
                    c.get("text", "") for c in content if c.get("type") == "text"
                )
            return str(content)
    return ""


def _tail_status(path: "str | _Path") -> AgenticProcessStatus:
    """Derive AgenticProcessStatus from the last 4 KB of a JSONL transcript.

    Algorithm:
      1. mtime check — is the file still being actively written (≤5 min)?
      2. Tail parse — what was the last meaningful entry type and stop_reason?
      3. Classify: terminal signals take priority; granular busy states only
         when the file is still active.

    Returns one of: INIT, EMPTY, COMPLETE, ERROR, INTERRUPTED, INACTIVE,
                    WAITING, THINKING, TOOL_CALL, TOOL_RUNNING, RUNNING.
    (IDLE, PAUSED, STEPPING are workflow states set externally, not transcript-derivable.)
    """
    p = _Path(path)
    try:
        stat = p.stat()
    except OSError:
        return AgenticProcessStatus.INIT

    is_active = (_time.time() - stat.st_mtime) <= _ACTIVE_SECONDS

    try:
        sz = stat.st_size
        with open(p, "rb") as f:
            if sz > _TAIL_BYTES:
                f.seek(sz - _TAIL_BYTES)
            chunk = f.read().decode("utf-8", errors="replace")
    except OSError:
        return AgenticProcessStatus.INIT

    # Entry types that carry no session-state signal and must not influence last_type.
    # e.g. permission-mode is written as both a session prologue and epilogue (after
    # last-prompt) by Claude Code; treating it as last_type would mask terminal signals.
    _IGNORED_TYPES: frozenset[str] = frozenset({
        "permission-mode",
        "file-history-snapshot",
    })

    last_type: str | None = None
    last_stop_reason: str | None = None
    for line in reversed(chunk.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        t = entry.get("type", "")
        if t in _IGNORED_TYPES:
            continue
        if last_type is None:
            last_type = t
        if t == "assistant" and last_stop_reason is None:
            last_stop_reason = entry.get("message", {}).get("stop_reason")
        if last_type and last_stop_reason is not None:
            break

    # Terminal signals — independent of mtime
    if last_type == "last-prompt":
        return AgenticProcessStatus.COMPLETE
    if last_type == "user" and "interrupted" in _last_user_text(chunk).lower():
        return AgenticProcessStatus.INTERRUPTED
    if last_stop_reason == "end_turn":
        return AgenticProcessStatus.COMPLETE
    if last_stop_reason == "stop_sequence":
        return AgenticProcessStatus.ERROR

    # Stale file with no clean termination signal → assumed dead
    if not is_active:
        return AgenticProcessStatus.INACTIVE

    if last_type is None:
        return AgenticProcessStatus.EMPTY

    # Granular active states (only when file is still being written)
    if last_type == "assistant" and last_stop_reason is None:
        return AgenticProcessStatus.THINKING
    if last_type == "assistant" and last_stop_reason == "tool_use":
        return AgenticProcessStatus.TOOL_CALL
    if last_type == "progress":
        return AgenticProcessStatus.TOOL_RUNNING
    if last_type == "user":
        return AgenticProcessStatus.WAITING

    return AgenticProcessStatus.RUNNING
