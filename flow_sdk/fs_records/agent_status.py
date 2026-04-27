"""WorkerStatus — expert-level state of the worker running inside an AgenticProcess.

Derived from the Claude transcript JSONL on every serialize (via ``_tail_status``);
never stored. Only meaningful when the containing ``ProcessStatus`` is one of
``RUNNING``, ``STOPPING``, or ``STOPPED`` — in any other lifecycle state, consumers
should treat the worker status as undefined.

See ``agentic_process_lifecycle.py`` for the companion ``ProcessStatus`` enum and
the two-axis model overview.

Neutral module with no intra-package imports. Both ClaudeSessionRecord and
AgenticProcessRecord import from here; this breaks the circular dependency that
would arise if the enum lived in either of those modules.
"""

from __future__ import annotations

import json
import time as _time
from datetime import datetime as _datetime
from pathlib import Path as _Path
from flow_sdk._compat import StrEnum


class WorkerStatus(StrEnum):
    """Expert-level worker state. Derived from the Claude JSONL transcript."""

    # Worker spun up; transcript not yet materialised. Replaces the former INIT + EMPTY split —
    # both meant "worker exists but has no parseable content yet", which is one state.
    INITIALIZING = "initializing"

    # Workflow default — no Claude session linked yet. Also the "ready for input" state
    # used by the ``isReadyForInput`` predicate (together with COMPLETE, INTERRUPTED).
    IDLE = "idle"

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
    API_ERROR    = "api_error"    # Anthropic API returned an error (e.g. 529); Claude is retrying — mid-turn
    API_TIMEOUT  = "api_timeout"  # JSONL stalled in WAITING state — connection hang / model slow to start

    # Parse fallback — the last JSONL entry did not match any known pattern. Surfaces
    # bugs (new Claude event types, malformed writes) instead of hiding them as "RUNNING".
    UNKNOWN      = "unknown"


# ---------------------------------------------------------------------------
# Status helper sets
#
# Invariant: these sets are kept byte-for-byte identical to the TS equivalents
# in ``ts_sdk/src/process/agentic-types.ts`` and enforced via a contract test
# loading ``test_fixtures/status_sets.json``.
# ---------------------------------------------------------------------------

_RUNNING_STATUSES: frozenset[WorkerStatus] = frozenset({
    WorkerStatus.WAITING,
    WorkerStatus.THINKING,
    WorkerStatus.TOOL_CALL,
    WorkerStatus.TOOL_RUNNING,
    WorkerStatus.API_ERROR,  # mid-turn retry — still running from the user's POV
})

_BUSY_STATUSES: frozenset[WorkerStatus] = frozenset({
    WorkerStatus.THINKING,
    WorkerStatus.TOOL_CALL,
    WorkerStatus.TOOL_RUNNING,
})

_TERMINAL_STATUSES: frozenset[WorkerStatus] = frozenset({
    WorkerStatus.COMPLETE,
    WorkerStatus.ERROR,
    WorkerStatus.INTERRUPTED,
    WorkerStatus.INACTIVE,
    WorkerStatus.API_TIMEOUT,  # stuck — needs intervention, not resumable as-is
})


def is_running(status: WorkerStatus) -> bool:
    """True while the worker is mid-turn (WAITING/THINKING/TOOL_CALL/TOOL_RUNNING/API_ERROR)."""
    return status in _RUNNING_STATUSES


def is_busy(status: WorkerStatus) -> bool:
    """True when actively processing (THINKING/TOOL_CALL/TOOL_RUNNING). Excludes WAITING/API_ERROR."""
    return status in _BUSY_STATUSES


def is_idle(status: WorkerStatus) -> bool:
    """True when the worker is not mid-turn. Inverse of is_running()."""
    return status not in _RUNNING_STATUSES


def is_terminal(status: WorkerStatus) -> bool:
    """True when the session has ended and cannot be resumed."""
    return status in _TERMINAL_STATUSES


# ---------------------------------------------------------------------------
# _tail_status — fast JSONL tail-read → WorkerStatus
# ---------------------------------------------------------------------------

_TAIL_BYTES = 4096
_ACTIVE_SECONDS = 300  # JSONL mtime within 5 min → session still being written


def _has_pending_tool_use(chunk: str) -> bool:
    """True when the latest assistant ``tool_use`` has no completion evidence.

    Walks the JSONL chunk forward (oldest→newest) and tracks the most recent
    ``assistant`` entry whose ``stop_reason == "tool_use"``. If a completion
    signal — ``file-history-snapshot``, a ``user`` event with a ``tool_result``
    block, or another ``assistant`` with ``stop_reason == "end_turn"`` —
    appears after that entry, the tool has been resolved. Otherwise the worker
    is mid-tool execution and ``last-prompt`` is a premature idle marker.
    """
    pending = False
    for line in chunk.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        t = entry.get("type", "")
        msg = entry.get("message", {}) if isinstance(entry.get("message"), dict) else {}
        if t == "assistant":
            stop = msg.get("stop_reason")
            if stop == "tool_use":
                pending = True
            elif stop == "end_turn":
                pending = False
        elif t == "user" and pending:
            content = msg.get("content")
            if isinstance(content, list) and any(
                isinstance(b, dict) and b.get("type") == "tool_result"
                for b in content
            ):
                pending = False
        elif t == "file-history-snapshot" and pending:
            pending = False
    return pending


def _has_completed_assistant(chunk: str) -> bool:
    """True when at least one ``assistant`` entry has appeared in the chunk.

    Claude 2.x can write ``last-prompt`` as a queue/ack marker BEFORE the
    assistant turn starts (right after ``user`` + ``attachment`` events).
    Treating that early ``last-prompt`` as terminal causes the test to exit
    before Claude has actually thought about the prompt. Requiring at least
    one assistant entry guarantees Claude has begun (and typically finished)
    generating output before we consider the turn complete.
    """
    for line in chunk.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("type") == "assistant":
            return True
    return False


def _last_assistant_stop_reason(chunk: str) -> str | None:
    """Return the ``stop_reason`` of the most recent ``assistant`` entry, or None.

    Used by ``stream_transcript`` to distinguish "model just used a tool and is
    planning the next call" (``stop_reason=tool_use``, more work expected) from
    "model finished its turn" (``stop_reason=end_turn``). Treating both as
    soft-terminal exits before the next tool call lands.
    """
    for line in reversed(chunk.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("type") != "assistant":
            continue
        msg = entry.get("message", {}) if isinstance(entry.get("message"), dict) else {}
        return msg.get("stop_reason")
    return None


def _last_user_is_tool_result(chunk: str) -> bool:
    """True when the most recent ``user`` entry carries a ``tool_result`` block.

    Distinguishes "user just sent a fresh prompt" (the worker is genuinely
    WAITING for assistant output) from "user is the tool runtime returning a
    tool_result" (the worker just finished its side effects). The latter is
    safe to treat as terminal once no other tool_use remains pending.
    """
    for line in reversed(chunk.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("type") != "user":
            continue
        msg = entry.get("message", {}) if isinstance(entry.get("message"), dict) else {}
        content = msg.get("content")
        if isinstance(content, list):
            return any(
                isinstance(b, dict) and b.get("type") == "tool_result"
                for b in content
            )
        return False
    return False


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


class ApiErrorTimeoutError(TimeoutError):
    """Raised by stream_transcript when it times out while the process is in API_ERROR state.

    This means the Anthropic API returned repeated errors (e.g. HTTP 529 overloaded)
    and Claude was still retrying when the timeout expired. This is an infrastructure
    issue, not a logic failure — tests should skip rather than fail on this exception.
    """


def _tail_status(path: "str | _Path") -> WorkerStatus:
    """Derive WorkerStatus from the last 4 KB of a JSONL transcript.

    Algorithm:
      1. mtime check — is the file still being actively written (≤5 min)?
      2. Tail parse — what was the last meaningful entry type and stop_reason?
      3. Classify: terminal signals take priority; granular busy states only
         when the file is still active. Fallback is UNKNOWN (not RUNNING) so
         that new / malformed event types are visible.

    Returns one of: INITIALIZING, COMPLETE, ERROR, INTERRUPTED, INACTIVE,
                    WAITING, THINKING, TOOL_CALL, TOOL_RUNNING, API_ERROR,
                    API_TIMEOUT, UNKNOWN.
    (IDLE is a workflow state set externally, not transcript-derivable.)
    """
    p = _Path(path)
    try:
        stat = p.stat()
    except OSError:
        # Transcript file doesn't exist yet — worker initialising.
        return WorkerStatus.INITIALIZING

    is_active = (_time.time() - stat.st_mtime) <= _ACTIVE_SECONDS

    try:
        sz = stat.st_size
        with open(p, "rb") as f:
            if sz > _TAIL_BYTES:
                f.seek(sz - _TAIL_BYTES)
            chunk = f.read().decode("utf-8", errors="replace")
    except OSError:
        return WorkerStatus.INITIALIZING

    # Entry types that carry no session-state signal and must not influence last_type.
    # e.g. permission-mode is written as both a session prologue and epilogue (after
    # last-prompt) by Claude Code; treating it as last_type would mask terminal signals.
    _IGNORED_TYPES: frozenset[str] = frozenset({
        "permission-mode",
        "file-history-snapshot",
    })

    last_type: str | None = None
    last_subtype: str | None = None
    last_stop_reason: str | None = None
    last_user_ts: float | None = None
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
            if t == "system":
                last_subtype = entry.get("subtype")
            if t == "user":
                ts_str = entry.get("timestamp", "")
                if ts_str:
                    try:
                        last_user_ts = _datetime.fromisoformat(
                            ts_str.replace("Z", "+00:00")
                        ).timestamp()
                    except Exception:
                        pass
        if t == "assistant" and last_stop_reason is None:
            last_stop_reason = entry.get("message", {}).get("stop_reason")
        if last_type and last_stop_reason is not None:
            break

    # Claude 2.x writes ``last-prompt`` as an idle marker — but in PTY mode it
    # can appear *between* an assistant ``stop_reason=tool_use`` and the actual
    # tool execution (which the JSONL records via a subsequent
    # ``file-history-snapshot`` and a SECOND ``last-prompt``). Treating the
    # first ``last-prompt`` as terminal causes ``stream_transcript`` to exit
    # before the file write lands, breaking long tests that assert artifacts on
    # disk. Detect the in-flight tool case by walking forward and checking
    # whether the most recent ``last-prompt`` is preceded by an unclosed
    # ``tool_use`` (no ``file-history-snapshot`` or ``end_turn`` after it).
    if last_type == "last-prompt":
        # ``last-prompt`` can appear *before* any assistant message — Claude
        # writes a queue/ack marker right after ``user`` + ``attachment`` and
        # only then starts thinking. Don't declare COMPLETE until there's at
        # least one assistant entry AND no pending tool execution.
        if not _has_completed_assistant(chunk):
            return WorkerStatus.WAITING
        if _has_pending_tool_use(chunk):
            return WorkerStatus.TOOL_RUNNING
        return WorkerStatus.COMPLETE
    if last_type == "user" and "interrupted" in _last_user_text(chunk).lower():
        return WorkerStatus.INTERRUPTED
    if last_stop_reason == "end_turn":
        return WorkerStatus.COMPLETE
    if last_stop_reason == "stop_sequence":
        return WorkerStatus.ERROR


    # Stale file with no clean termination signal → assumed dead
    if not is_active:
        return WorkerStatus.INACTIVE

    # JSONL exists but has no parseable content — still initialising.
    if last_type is None:
        return WorkerStatus.INITIALIZING

    # Granular active states (only when file is still being written)
    if last_type == "system" and last_subtype == "api_error":
        return WorkerStatus.API_ERROR
    if last_type == "assistant" and last_stop_reason is None:
        return WorkerStatus.THINKING
    if last_type == "assistant" and last_stop_reason == "tool_use":
        return WorkerStatus.TOOL_CALL
    if last_type == "progress":
        return WorkerStatus.TOOL_RUNNING
    if last_type == "user":
        if last_user_ts and (_time.time() - last_user_ts) > 30:
            return WorkerStatus.API_TIMEOUT
        return WorkerStatus.WAITING

    # Unrecognised entry type — surface as UNKNOWN so new Claude event types or
    # malformed writes are visible, rather than silently masked as "running".
    return WorkerStatus.UNKNOWN
