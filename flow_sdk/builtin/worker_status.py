"""WorkerStatus — raw "what we found" state of the worker inside an AgenticProcess.

The values are worker lingo: the union of the granular states the various worker
vendors (claude / codex / copilot) can evidence in their transcripts. Derived
from the vendor transcript tail on every serialize (via ``_tail_status`` and the
per-vendor ``status.py`` maps); never stored. Only meaningful when the containing
``ProcessStatus`` is one of ``RUNNING``, ``STOPPING``, or ``STOPPED``.

This is the "what we found" axis. The companion axes are the lifecycle
``ProcessStatus`` FSM (``process_lifecycle.py``) and the derived ``busy`` boolean
(``status_predicates.is_turn_busy``). Worker statuses are never projected or
synthesized here; the ``busy`` mapping lives entirely in ``status_predicates``.

See ``process_lifecycle.py`` for the companion ``ProcessStatus`` enum and
``docs/agent/agentic_process_statuses.md`` for the two-axis model overview.

Neutral module with no intra-package imports. Both ClaudeSessionRecord and
AgenticProcessRecord import from here; this breaks the circular dependency that
would arise if the enum lived in either of those modules.
"""

from __future__ import annotations

import json
import time as _time
from datetime import datetime as _datetime
from pathlib import Path as _Path
from typing import NamedTuple

from flow_sdk._compat import StrEnum


class WorkerStatus(StrEnum):
    """Expert-level worker state. Derived from the Claude JSONL transcript."""

    # Worker spun up; transcript not yet materialised. Replaces the former INIT + EMPTY split —
    # both meant "worker exists but has no parseable content yet", which is one state.
    INITIALIZING = "initializing"

    # No worker session linked / at the prompt. Raw-derivable from a ``system:init``
    # tail (worker booted and is sitting at the prompt) and the default for a
    # spawned-but-never-prompted worker.
    IDLE = "idle"

    # Terminal — session ended, cannot resume
    COMPLETE = "complete"  # finished cleanly (end_turn / last-prompt)
    ERROR = "error"  # abnormal end (stop_sequence / crash)
    INTERRUPTED = "interrupted"  # user interrupted (Escape / Ctrl-C)
    INACTIVE = "inactive"  # raw: stale file >5 min with no terminal signal

    # Raw: an unresolved user-input tool (AskUserQuestion / ExitPlanMode) sits at
    # the tail — the worker asked and handed control back to the user. Surfaced as
    # "Idle" to the user. (This is NOT a backend projection: it is read directly
    # from the transcript by ``_tail_status``; the logical process status maps it
    # to ``ready``.)
    PENDING_USER = "pending_user"

    # Active — transcript-derivable
    WORKING = "working"  # input received, Claude is producing a reply (pre-first-token lull through streaming)
    THINKING = "thinking"  # assistant streaming / generating text
    TOOL_CALL = "tool_call"  # Claude finished its turn and dispatched tool(s)
    TOOL_RUNNING = "tool_running"  # tool is actively executing (progress events)
    API_ERROR = "api_error"  # Anthropic API returned an error (e.g. 529); Claude is retrying — mid-turn
    API_TIMEOUT = "api_timeout"  # JSONL stalled in WORKING state — connection hang / model slow to start

    # Parse fallback — the last JSONL entry did not match any known pattern. Surfaces
    # bugs (new Claude event types, malformed writes) instead of hiding them as "RUNNING".
    UNKNOWN = "unknown"


# ---------------------------------------------------------------------------
# Status helper sets
#
# Invariant: these sets are kept byte-for-byte identical to the TS equivalents
# in ``ts_sdk/src/process/agentic-types.ts`` and enforced via a contract test
# loading ``test_fixtures/status_sets.json``.
# ---------------------------------------------------------------------------

_RUNNING_STATUSES: frozenset[WorkerStatus] = frozenset(
    {
        WorkerStatus.WORKING,
        WorkerStatus.THINKING,
        WorkerStatus.TOOL_CALL,
        WorkerStatus.TOOL_RUNNING,
        WorkerStatus.API_ERROR,  # mid-turn retry — still running from the user's POV
    }
)

_TERMINAL_STATUSES: frozenset[WorkerStatus] = frozenset(
    {
        WorkerStatus.COMPLETE,
        WorkerStatus.ERROR,
        WorkerStatus.INTERRUPTED,
        WorkerStatus.INACTIVE,
        WorkerStatus.API_TIMEOUT,  # stuck — needs intervention, not resumable as-is
    }
)


_ERROR_STATUSES: frozenset[WorkerStatus] = frozenset(
    {
        WorkerStatus.ERROR,
        WorkerStatus.API_TIMEOUT,
        WorkerStatus.INACTIVE,
    }
)

# Live process-lifecycle states. String literals (not ProcessStatus) keep this a
# true leaf module. ``running`` is the single live value on both realms now (no
# more ``ready`` / ``busy`` projection).
_LIVE_PROCESS_STATUSES: frozenset[str] = frozenset({"running", "starting"})


class ExecutionMode(StrEnum):
    """Coarse "kind of running worker" for the footer worker-list chip.

    Mirrors the TS ``ExecutionMode`` in ``ts_sdk/src/process/agentic-types.ts``.
    Derived, never stored. ``EXTERNAL`` is server-only (OS-scanned).
    """

    INTERACTIVE = "interactive"  # PTY worker (pty_mode=true)
    BACKGROUND = "background"  # headless CLI worker (pty_mode=false)
    ERROR = "error"  # error/dead state
    EXTERNAL = "external"  # running outside the app (OS-scanned)


def classify_execution_mode(
    *,
    status: str | None,
    worker_status: str | None,
    pty_mode: bool | None,
    pid_alive: bool | None = None,
) -> ExecutionMode | None:
    """Classify a *live* worker into an ``ExecutionMode`` (or ``None`` when the
    process is not live). Keyed on the *transport* ``pty_mode`` (NOT tab
    ``visible``), mirroring the TS ``classifyExecutionMode`` truth table:

      1. worker_status ∈ _ERROR_STATUSES                 → ERROR
      2. pty_mode is not False and pid_alive is False     → ERROR (dead PTY)
      3. pty_mode is not False                            → INTERACTIVE
      4. pty_mode is False                                → BACKGROUND

    A hidden live PTY (``visible=False`` but ``pty_mode=True``) classifies as
    INTERACTIVE — it is a PTY worker, just not shown as a tab. ``EXTERNAL`` is
    never returned here. ``pid_alive`` only matters for PTY (rule 2); headless CLI
    workers have no PID, so rule 2 never applies to them.
    """
    if status not in _LIVE_PROCESS_STATUSES:
        return None
    if worker_status is not None and worker_status in _ERROR_STATUSES:
        return ExecutionMode.ERROR
    is_pty = pty_mode is not False
    if is_pty and pid_alive is False:
        return ExecutionMode.ERROR
    return ExecutionMode.INTERACTIVE if is_pty else ExecutionMode.BACKGROUND


def is_running(status: WorkerStatus) -> bool:
    """True while the worker is mid-turn (WORKING/THINKING/TOOL_CALL/TOOL_RUNNING/API_ERROR)."""
    return status in _RUNNING_STATUSES


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
ACTIVE_SECONDS = 300  # JSONL mtime within 5 min → session still being written

# Upper bound for the expanding tail read. A transcript can accumulate a long
# trailing run of content-free session-envelope lines (ai-title / agent-name /
# mode / bridge-session …) that buries the last real chat entry well beyond the
# initial 4 KB window. When the first window holds nothing but ignored types we
# read progressively larger tails — up to this cap — so the true WorkerStatus is
# still recoverable instead of collapsing to UNKNOWN. Bounded so the per-serialize
# cost stays trivial for healthy sessions (which resolve in the first 4 KB).
_TAIL_MAX_BYTES = 2 * 1024 * 1024

# Content-free Claude/Flowpad transcript line types — they carry no worker-state
# signal and MUST be skipped when scanning the tail for the last meaningful entry.
# Kept in sync with ``transcript_analyzer/parsers/claude.py`` ``_META_TYPES``
# (minus ``last-prompt``, which ``_tail_status`` classifies explicitly). The
# contract test ``test_ignored_types_match_meta_types`` enforces that parity, so a
# future Claude format-drift — which is exactly how ``mode`` / ``agent-name`` /
# ``bridge-session`` slipped in and regressed this set to masking real status as
# UNKNOWN — can't silently happen again.
_IGNORED_TYPES: frozenset[str] = frozenset(
    {
        "file-history-snapshot",
        "queue-operation",
        "custom-title",
        "ai-title",
        "pr-link",
        "attachment",
        "permission-mode",
        "mode",
        "agent-name",
        "bridge-session",
        "atis-latch",
    }
)


# Tools whose ``tool_use`` block BLOCKS on a human response. While one is pending
# (its ``tool_result`` — keyed by ``tool_use_id`` — hasn't landed yet) the worker
# has handed control back to the user and is idle awaiting them, NOT executing a
# tool. Surfacing that as PENDING_USER ("Idle", no spinner) instead of
# TOOL_CALL/TOOL_RUNNING is the whole point of ``_pending_user_input_tool``.
_USER_INPUT_TOOLS: frozenset[str] = frozenset(
    {
        "AskUserQuestion",
        "ExitPlanMode",
    }
)


# Synthetic "user" entries Claude Code injects when the human aborts a turn
# (Escape / Ctrl-C) — ``[Request interrupted by user]`` /
# ``[Request interrupted by user for tool use]``. Matched as a PREFIX (not a bare
# ``"interrupted"`` substring) so a genuine human prompt that merely mentions the
# word can't be misread as an abort.
_INTERRUPT_MARKER_PREFIX = "[request interrupted"


def _last_user_is_interrupt(chunk: str) -> bool:
    """True when the most-recent ``user`` entry is a synthetic interrupt marker.

    A fresh prompt submitted after the interrupt replaces that user text, so this
    only reports True while the abort is genuinely the last thing the user did.
    """
    return _last_user_text(chunk).strip().lower().startswith(_INTERRUPT_MARKER_PREFIX)


def _pending_user_input_tool(chunk: str) -> bool:
    """True when an unresolved user-input ``tool_use`` (``AskUserQuestion`` /
    ``ExitPlanMode``) sits at the tail — i.e. Claude asked and is blocked on the
    user's answer.

    Pairs ``tool_use`` blocks to their ``tool_result`` by ``tool_use_id`` (the
    same id Claude echoes back when the user responds), so it is robust to the
    streaming split that scatters one logical turn across several ``assistant``
    lines and to intervening meta/idle markers. Returns True iff at least one
    user-input tool id has no matching ``tool_result``.
    """
    open_ids: set[str] = set()
    resolved: set[str] = set()
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
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        if t == "assistant":
            for b in content:
                if (
                    isinstance(b, dict)
                    and b.get("type") == "tool_use"
                    and b.get("name") in _USER_INPUT_TOOLS
                    and b.get("id")
                ):
                    open_ids.add(b["id"])
        elif t == "user":
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    tid = b.get("tool_use_id")
                    if tid:
                        resolved.add(tid)
    return bool(open_ids - resolved)


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
                isinstance(b, dict) and b.get("type") == "tool_result" for b in content
            ):
                pending = False
        elif t == "file-history-snapshot" and pending:
            pending = False
    return pending


def _last_user_is_tool_result(chunk: str) -> bool:
    """True when the most recent ``user`` entry carries a ``tool_result`` block.

    Distinguishes "user just sent a fresh prompt" (the worker is genuinely
    WORKING on a reply) from "user is the tool runtime returning a
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
            return any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
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
                return " ".join(c.get("text", "") for c in content if c.get("type") == "text")
            return str(content)
    return ""


class ApiErrorTimeoutError(TimeoutError):
    """Raised by stream_transcript when it times out while the process is in API_ERROR state.

    This means the Anthropic API returned repeated errors (e.g. HTTP 529 overloaded)
    and Claude was still retrying when the timeout expired. Tests retain the failure
    and its API_ERROR context for diagnosis.
    """


def _scan_reversed(
    chunk: str,
) -> tuple[str | None, str | None, str | None, float | None, bool]:
    """Walk a JSONL chunk newest→oldest and return the classification inputs for
    the last *meaningful* entry: ``(last_type, last_subtype, last_stop_reason,
    last_user_ts, reached_user_boundary)``.

    Content-free session-envelope lines (``_IGNORED_TYPES``) are skipped so the
    trailing ai-title / agent-name / mode / bridge-session run that Claude Code
    writes as a session prologue/epilogue doesn't mask the real terminal/active
    signal. ``last_type`` is None when the chunk holds no non-ignored, parseable
    entry — the caller uses that to decide whether to widen the tail read.

    Assistant terminal evidence is scoped to the newest user turn. Once the
    reverse scan reaches that user entry it stops, so an ``end_turn`` from the
    previous turn cannot make a fresh prompt look already complete.
    """
    last_type: str | None = None
    last_subtype: str | None = None
    last_stop_reason: str | None = None
    last_user_ts: float | None = None
    reached_user_boundary = False
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
            reached_user_boundary = True
            if last_user_ts is None:
                ts_str = entry.get("timestamp", "")
                if ts_str:
                    try:
                        last_user_ts = _datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
                    except Exception:
                        pass
            break
        if t == "assistant" and last_stop_reason is None:
            last_stop_reason = entry.get("message", {}).get("stop_reason")
        if last_type and last_stop_reason is not None:
            break
    return (
        last_type,
        last_subtype,
        last_stop_reason,
        last_user_ts,
        reached_user_boundary,
    )


class StatusDetail(NamedTuple):
    """One synthetic-error entry: what it said, and WHICH entry said it.

    ``text`` alone is not enough to tell two failures apart. Every signed-out
    turn produces the byte-identical ``"Not logged in · Please run /login"``, so
    a consumer keyed on the text cannot distinguish "the same entry, re-read on
    the next serialize" from "a new turn was refused". ``entry_id`` is the
    transcript entry's own ``uuid``: stable across re-reads of the same entry —
    which is what makes a poll idempotent — and different for a genuinely new
    one. A timestamp would not do: it is millisecond-resolution, so two entries
    can share one, and a clock adjustment can move it backwards.

    A NamedTuple rather than a ``DataSpec`` on purpose: this module is
    deliberately neutral with no intra-package imports (see the module
    docstring), and importing the schema package here would reintroduce exactly
    the circular dependency that neutrality exists to prevent. The shape does
    not travel either — the serializer flattens it into sibling API fields.
    """

    text: str
    entry_id: str | None


def tail_status_detail(path: "str | _Path") -> StatusDetail | None:
    """The CLI's OWN words for the most recent synthetic error, or ``None``.

    :data:`WorkerStatus.ERROR` is a single token, and collapsing into it throws
    away a message the CLI already wrote for the user. Claude Code's synthetic
    error entries are genuinely good — ``"Not logged in · Please run /login"``,
    ``"You've hit your session limit · resets 7:50pm"`` — and every one of them
    was reaching users as the bare word "Error", which tells them nothing and
    sends them hunting. This recovers the sentence.

    Deliberately cheap and best-effort: one bounded tail read, no widening, and
    every failure returns ``None`` so a status can never depend on it. Callers
    should only ask when the status is already terminal-error, since it costs a
    second read of the same file.
    """
    p = _Path(path)
    try:
        sz = p.stat().st_size
        # Same ceiling ``_tail_status`` widens to. A single read rather than its
        # doubling loop: the error we want is the entry that PRODUCED the status
        # we were handed, so it is near the end — the ceiling only covers a turn
        # whose tool results pushed it back.
        window = min(sz, _TAIL_MAX_BYTES)
        with open(p, "rb") as f:
            if sz > window:
                f.seek(sz - window)
            chunk = f.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    for line in reversed(chunk.splitlines()):
        line = line.strip()
        if not line:
            continue
        # Scoped to the newest user turn, exactly as ``_scan_reversed`` scopes
        # its terminal evidence — and for the same reason. A signed-out turn
        # leaves "Not logged in · Please run /login" in the transcript forever;
        # without this boundary a later, perfectly healthy turn would still
        # report it, and anything keyed on the text (the harness-login prompt)
        # would fire at a user who is signed in. An error only describes THIS
        # turn if it comes after the last thing the user said.
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("type") == "user":
            return None
        if not entry.get("isApiErrorMessage"):
            continue
        content = (entry.get("message") or {}).get("content")
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = " ".join(b.get("text", "") for b in content if isinstance(b, dict))
        else:
            continue
        text = text.strip()
        if text:
            return StatusDetail(text=text, entry_id=entry.get("uuid") or None)
    return None


def _tail_status(path: "str | _Path") -> WorkerStatus:
    """Derive WorkerStatus from the tail of a JSONL transcript.

    Algorithm:
      1. mtime check — is the file still being actively written (≤5 min)?
      2. Tail parse — scan the last 4 KB (widening up to ``_TAIL_MAX_BYTES`` if
         that window is all content-free envelope lines) for the last meaningful
         entry type and stop_reason.
      3. Classify: terminal signals take priority; granular busy states only
         when the file is still active. Fallback is UNKNOWN (not RUNNING) so
         that new / malformed event types are visible.

    Returns one of: INITIALIZING, IDLE, PENDING_USER, COMPLETE, ERROR,
                    INTERRUPTED, INACTIVE, WORKING, THINKING, TOOL_CALL,
                    TOOL_RUNNING, API_ERROR, API_TIMEOUT, UNKNOWN.
    (IDLE is derivable — a ``system:init`` tail means the worker booted and is
    sitting at the prompt.)
    """
    p = _Path(path)
    try:
        stat = p.stat()
    except OSError:
        # Transcript file doesn't exist yet — worker initialising.
        return WorkerStatus.INITIALIZING

    is_active = (_time.time() - stat.st_mtime) <= ACTIVE_SECONDS
    sz = stat.st_size

    # Expanding tail read: start at 4 KB and widen (×16, clamped to
    # ``_TAIL_MAX_BYTES``) while the window holds nothing but ignored
    # session-envelope lines (``last_type is None``), so a long trailing meta run
    # can't bury the real last chat entry and force a spurious UNKNOWN. Healthy
    # sessions find a meaningful entry in the first 4 KB and never expand; the
    # read never exceeds ``_TAIL_MAX_BYTES``.
    #
    # ALSO widen when the tail ends in a ``last-prompt`` idle marker but the
    # window doesn't yet contain current-turn assistant evidence or the newest
    # user boundary. A single oversized assistant line can strand both beyond
    # the 4 KB window. Widen until either signal is found (or the read reaches
    # the file start / ``_TAIL_MAX_BYTES``).
    last_type: str | None = None
    last_subtype: str | None = None
    last_stop_reason: str | None = None
    last_user_ts: float | None = None
    reached_user_boundary = False
    read_bytes = _TAIL_BYTES
    while True:
        window = min(read_bytes, sz)
        try:
            with open(p, "rb") as f:
                if sz > window:
                    f.seek(sz - window)
                chunk = f.read().decode("utf-8", errors="replace")
        except OSError:
            return WorkerStatus.INITIALIZING
        (
            last_type,
            last_subtype,
            last_stop_reason,
            last_user_ts,
            reached_user_boundary,
        ) = _scan_reversed(chunk)
        if window >= sz or read_bytes >= _TAIL_MAX_BYTES:
            break
        need_wider = last_type is None or (
            last_type == "last-prompt" and last_stop_reason is None and not reached_user_boundary
        )
        if not need_wider:
            break
        read_bytes = min(read_bytes * 16, _TAIL_MAX_BYTES)

    # A pending user-input tool (AskUserQuestion / ExitPlanMode) dominates every
    # other reading of the tail: Claude has yielded to the user and is idle until
    # they answer. Detect it by ``tool_use_id`` pairing (not last-entry shape) so
    # trailing ``last-prompt``/``mode``/envelope markers — or the streaming split
    # of the asking turn — can't mask it as TOOL_CALL/TOOL_RUNNING and spin the
    # spinner forever. Answered questions pair their ``tool_result`` and fall
    # through to the normal classification below. The cheap substring gate skips
    # the extra parse pass on the hot path unless a user-input tool name is
    # literally present in the tail (it must be, verbatim, for a match).
    if any(name in chunk for name in _USER_INPUT_TOOLS) and _pending_user_input_tool(chunk):
        return WorkerStatus.PENDING_USER

    # A user interrupt (Escape / Ctrl-C) is an idle, resumable terminal state —
    # but Claude writes trailing ``last-prompt`` / ``system`` envelope markers
    # AFTER the ``[Request interrupted by user]`` entry. Those markers make
    # ``_scan_reversed`` report ``last_type == "last-prompt"``, and the
    # ``last-prompt`` branch below — seeing no completed assistant turn in-window
    # (the killed turn's assistant message is beyond the tail, or never got an
    # ``end_turn``) — would pin the worker at WORKING forever ("stuck working"
    # after an interrupted session). Detect the interrupt by the most-recent user
    # text and surface it directly, exactly as the pending-user-input-tool check
    # does above, so the trailing envelope run can't mask it. The cheap substring
    # gate skips the reversed json-parse pass on the hot path unless the marker is
    # literally present in the tail (it must be, verbatim, for a prefix match).
    if _INTERRUPT_MARKER_PREFIX in chunk.lower() and _last_user_is_interrupt(chunk):
        return WorkerStatus.INTERRUPTED

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
        # only then starts thinking. Don't declare COMPLETE until this turn has
        # terminal assistant evidence and no pending tool execution.
        if last_stop_reason is None:
            return WorkerStatus.WORKING
        if _has_pending_tool_use(chunk):
            return WorkerStatus.TOOL_RUNNING
        # ``last-prompt`` also rides in as an idle ack *between* tool calls:
        # the model finished a tool (tool_result landed, so nothing is pending)
        # and is slowly planning its next call. When the most recent assistant
        # turn ended with ``stop_reason=tool_use`` the model is still mid-turn —
        # the trailing ``last-prompt`` is NOT a turn end. Declaring COMPLETE here
        # cuts ``stream_transcript`` off during a long inter-tool pause (Opus can
        # take 20-40 s), so the diagnose runner never scrapes the final report
        # and falsely reports "not recorded". A ``stop_sequence`` error is also
        # terminal; Claude may append ``last-prompt`` after synthetic API/limit
        # errors, and treating that as WORKING pins the UI forever.
        if last_stop_reason == "stop_sequence":
            return WorkerStatus.ERROR
        # Only a genuine ``end_turn`` is success-terminal; otherwise stay
        # WORKING and keep reading. (Mirrors the ``stop_reason=="end_turn"``
        # guard on the ``_post_tool_idle`` path.)
        if last_stop_reason != "end_turn":
            return WorkerStatus.WORKING
        return WorkerStatus.COMPLETE
    # (A user interrupt is caught by the priority ``_last_user_is_interrupt`` check
    # above — before the ``last-prompt`` branch — so no separate ``last_type ==
    # "user"`` interrupt case is needed here.)
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
    # ``system:init`` is Claude's first JSONL line — it means the worker booted,
    # established the session, and is now sitting at the prompt waiting for the
    # first user turn. Nothing after it = idle/ready, NOT "still initialising"
    # and NOT an unrecognised type. (Once a turn starts, later lines override
    # this on the next tail read.)
    if last_type == "system" and last_subtype == "init":
        return WorkerStatus.IDLE
    if last_type == "assistant" and last_stop_reason is None:
        return WorkerStatus.THINKING
    if last_type == "assistant" and last_stop_reason == "tool_use":
        return WorkerStatus.TOOL_CALL
    if last_type == "progress":
        return WorkerStatus.TOOL_RUNNING
    if last_type == "user":
        if last_user_ts and (_time.time() - last_user_ts) > 90:
            return WorkerStatus.API_TIMEOUT
        return WorkerStatus.WORKING

    # Unrecognised entry type — surface as UNKNOWN so new Claude event types or
    # malformed writes are visible, rather than silently masked as "running".
    return WorkerStatus.UNKNOWN
