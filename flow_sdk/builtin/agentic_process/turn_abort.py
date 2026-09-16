"""Durable, flowpad-authored turn-abort markers for agentic processes.

Why this exists (issue D09): cancelling a headless (print-mode) turn SIGTERMs
the vendor CLI. The vendor transcript (codex rollout / claude session JSONL)
then ends at whatever the CLI last flushed — typically an unmatched tool call
and NO abort record — so a history replay after reload renders the cancelled
call as still running. The live UI only settled because the in-memory stream
ended; nothing durable said "this turn was aborted".

The vendor transcript files are vendor-owned; flowpad never forges entries
into them (the codebase only ever *reads* rollouts / claude JSONLs). Instead,
cancellation appends one line to a flowpad-owned sidecar in the process record
dir (next to ``codex_transcript.jsonl`` / ``prompt_queue.json``):

    <records_root>/agentic_process/<stem>/turn_events.jsonl
    {"type": "turn_aborted", "timestamp": ..., "session_id": ..., "reason": ...}

``AgenticProcess.get_history_action`` merges these markers chronologically
into the driver-loaded history as STATUS frames shaped like the canonical
abort event the UI already understands from live codex rollouts
(``event_msg.turn_aborted``), additionally stamped with the vendor-neutral
``turn-terminated: "true"`` attribute the chat grouping keys on. This is
worker-generic: claude/codex/copilot all share the same cancel choke point
(``_http_cancel_prompt`` → ``worker.close_session()``) and the same gap.

Scoping promise: a marker applies to exactly one session's replay. A marker
stamped with a session id is filtered on it. A marker recorded WITHOUT a
session id (cancel before the worker reported one) can only belong to the
session that was live when it was written — unknowable retroactively — so the
practical rule is chronological overlap: a sid-less marker is included only
when it is not older than the replayed rollout's first frame
(``history_start``). Otherwise it belongs to a rotated-away session and would
insert a phantom "turn aborted" at index 0 of every future session forever.

PTY-transport cancels (Ctrl-C into the live TUI) intentionally do NOT write a
marker: the vendor TUI records its own durable abort (codex writes
``event_msg.turn_aborted`` into the rollout; claude pairs the interrupted tool
call with an "[Request interrupted by user]" result).

Logger namespace: ``flow_sdk.builtin.agentic_process.turn_abort``.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

from flow_sdk.builtin.agentic_process._shared import _now_iso, _parse_iso_datetime
from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

logger = logging.getLogger(__name__)

TURN_EVENTS_FILENAME = "turn_events.jsonl"

#: Attribute stamped on every abort STATUS frame (flowpad markers AND replayed
#: vendor ``event_msg.turn_aborted`` events). The UI keys on this — it is the
#: semantic "the turn ended without completing its in-flight tools" signal,
#: independent of any vendor's event naming.
TURN_TERMINATED_ATTR = "turn-terminated"

#: Subtype of flowpad-authored abort markers (vendor-neutral, unlike the
#: codex-organic ``event_msg.turn_aborted`` replay subtype).
ABORT_MARKER_SUBTYPE = "turn_aborted"


def turn_events_path(record_dir: Path) -> Path:
    return Path(record_dir) / TURN_EVENTS_FILENAME


def abort_status_frame(
    reason: str = "user_interrupt",
    *,
    created_time: str = "",
    extra_attributes: dict[str, str] | None = None,
) -> FlowData:
    """The canonical turn-abort STATUS frame — SINGLE constructor of the shape.

    Live worker cancels, converter-synthesized aborts, and the durable sidecar
    replay all emit this exact frame (the replay adds its provenance via
    ``extra_attributes``); the chat grouping keys on ``turn-terminated`` to
    mark in-flight tool calls terminated, not errored.
    """
    return FlowData(
        flow_value={"reason": reason},
        created_time=created_time,
        attributes={
            "element-type": FlowElementType.STATUS,
            "data-type": FlowDataType.OBJECT,
            "subtype": ABORT_MARKER_SUBTYPE,
            TURN_TERMINATED_ATTR: "true",
            **(extra_attributes or {}),
        },
    )


def record_turn_abort(
    record_dir: Path,
    *,
    session_id: str | None = None,
    reason: str = "user_interrupt",
) -> None:
    """Append one durable abort marker line. Best-effort — never raises.

    Called from the cancel path AFTER the worker kill has been issued; the
    marker's wall-clock timestamp therefore sorts after every frame the dying
    turn managed to flush and before any recovery turn.
    """
    line = {
        "type": ABORT_MARKER_SUBTYPE,
        "timestamp": _now_iso(timespec="milliseconds"),
        "session_id": session_id or "",
        "reason": reason,
    }
    try:
        record_dir = Path(record_dir)
        record_dir.mkdir(parents=True, exist_ok=True)
        with turn_events_path(record_dir).open("a", encoding="utf-8") as f:
            f.write(json.dumps(line) + "\n")
    except OSError:
        logger.warning("turn_abort: failed to persist abort marker in %s", record_dir, exc_info=True)


def load_abort_marker_frames(
    record_dir: Path,
    *,
    session_id: str | None = None,
    history_start: datetime | None = None,
) -> list[FlowData]:
    """Read the sidecar and return one replay STATUS frame per abort marker.

    ``session_id`` filters out markers stamped for a *different* session than
    the one whose history is being composed (a rotated/fresh session must not
    inherit another session's aborts). Markers recorded without a session id
    (a cancel before the worker reported one) are scoped chronologically
    instead: they are included only when they overlap the replayed rollout —
    i.e. they are not older than ``history_start`` (the replay's first frame,
    see :func:`history_start_time`). A sid-less marker older than the replay
    belongs to a rotated-away session and is excluded, so it cannot insert a
    phantom abort at index 0 of every future session. With no
    ``history_start`` (empty history, or a caller without one) sid-less
    markers are included — nothing proves them foreign.
    """
    path = turn_events_path(Path(record_dir))
    if not path.exists():
        return []
    frames: list[FlowData] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        logger.warning("turn_abort: failed to read %s", path, exc_info=True)
        return []
    for raw in text.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            marker = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(marker, dict) or marker.get("type") != ABORT_MARKER_SUBTYPE:
            continue
        marker_sid = str(marker.get("session_id") or "")
        if marker_sid:
            if session_id and marker_sid != session_id:
                continue
        else:
            marker_ts = _parse_iso_datetime(marker.get("timestamp"))
            if (
                history_start is not None
                and marker_ts is not None
                and marker_ts < history_start
            ):
                continue
        frames.append(
            abort_status_frame(
                str(marker.get("reason") or "user_interrupt"),
                created_time=str(marker.get("timestamp") or ""),
                extra_attributes={"observation-kind": "replay", "origin": "flowpad"},
            )
        )
    return frames


def history_start_time(history: list[FlowData]) -> datetime | None:
    """Timestamp of the first replayed frame with a parseable ``created_time``.

    The chronological lower bound of the replayed rollout — used to scope
    sid-less abort markers (see :func:`load_abort_marker_frames`). ``None``
    when the history is empty or carries no parseable timestamps.
    """
    for frame in history:
        ts = _parse_iso_datetime(getattr(frame, "created_time", None))
        if ts is not None:
            return ts
    return None


def merge_abort_markers(history: list[FlowData], markers: list[FlowData]) -> list[FlowData]:
    """Insert each marker at its chronological position in *history*.

    A frame with an unparsable/missing ``created_time`` never triggers an
    insertion before it (it stays attached to its predecessor) — the marker
    lands before the first frame that is provably later. Markers with no
    parseable timestamp are appended at the end (they can only have been
    written after everything currently in the transcript).
    """
    if not markers:
        return history
    out = list(history)
    for marker in markers:
        marker_ts = _parse_iso_datetime(marker.created_time)
        index = len(out)
        if marker_ts is not None:
            for i, frame in enumerate(out):
                frame_ts = _parse_iso_datetime(getattr(frame, "created_time", None))
                if frame_ts is not None and frame_ts > marker_ts:
                    index = i
                    break
        out.insert(index, marker)
    return out

