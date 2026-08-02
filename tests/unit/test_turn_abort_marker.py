"""Durable turn-abort markers (issue D09).

Cancelling a headless turn SIGTERMs the vendor CLI, which writes NOTHING
durable about the abort — the rollout ends at the unmatched tool call, so a
post-reload replay rendered the cancelled call as still running. The fix is a
flowpad-owned sidecar (``turn_events.jsonl`` in the process record dir) whose
markers ``get_history_action`` merges back into the replayed history as
terminated-turn STATUS frames.

These tests pin, at the module level:

* the pre-fix symptom — a cancelled codex rollout replays with an unmatched
  TOOL_CALL and no termination signal whatsoever;
* ``record_turn_abort`` → ``load_abort_marker_frames`` → ``merge_abort_markers``
  produces exactly one terminated-turn STATUS frame, chronologically placed
  after the aborted turn and BEFORE a later recovery turn;
* session filtering (a rotated session must not inherit foreign aborts);
* the organic codex ``event_msg.turn_aborted`` replay frame carries the same
  vendor-neutral ``turn-terminated`` attribute the UI keys on.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history import (
    load_transcript_history,
)
from flow_sdk.builtin.agentic_process.turn_abort import (
    load_abort_marker_frames,
    merge_abort_markers,
    record_turn_abort,
    turn_events_path,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(5)

_SID = "0199aaaa-1111-7000-9000-000000000001"


def _write_cancelled_rollout(path: Path, *, with_recovery_turn: bool = False) -> None:
    """A codex rollout as the CLI leaves it after a mid-tool SIGTERM: the
    function_call is flushed, its output never arrives."""
    rows = [
        {
            "timestamp": "2026-07-10T06:00:00.000Z",
            "type": "session_meta",
            "payload": {"id": _SID, "cwd": "/repo"},
        },
        {
            "timestamp": "2026-07-10T06:00:01.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": "user-1",
                "role": "user",
                "content": [{"type": "input_text", "text": "run something long"}],
            },
        },
        {
            "timestamp": "2026-07-10T06:00:02.000Z",
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "id": "call-entry-1",
                "name": "exec_command",
                "call_id": "call-1",
                "arguments": json.dumps({"cmd": "sleep 600"}),
            },
        },
    ]
    if with_recovery_turn:
        rows += [
            {
                "timestamp": "2026-07-10T06:05:00.000Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "id": "user-2",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "ok, do less"}],
                },
            },
            {
                "timestamp": "2026-07-10T06:05:01.000Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "id": "assistant-2",
                    "role": "assistant",
                    "phase": "final_answer",
                    "content": [{"type": "output_text", "text": "Recovered."}],
                },
            },
        ]
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")


def _write_marker_line(record_dir: Path, *, timestamp: str, session_id: str = _SID) -> None:
    """Seed the sidecar with a controlled timestamp (the file format is this
    module's own contract; ``record_turn_abort`` stamps wall-clock time)."""
    record_dir.mkdir(parents=True, exist_ok=True)
    line = {"type": "turn_aborted", "timestamp": timestamp, "session_id": session_id, "reason": "user_interrupt"}
    with turn_events_path(record_dir).open("a", encoding="utf-8") as f:
        f.write(json.dumps(line) + "\n")


def _is_terminated_status(fd) -> bool:
    return (
        fd.attributes.get("element-type") == FlowElementType.STATUS and fd.attributes.get("turn-terminated") == "true"
    )


def test_cancelled_rollout_replay_has_no_termination_signal(tmp_path: Path):
    """Pre-fix symptom: the vendor transcript alone carries no abort record —
    the unmatched TOOL_CALL replays with nothing that terminates it."""
    rollout = tmp_path / "rollout.jsonl"
    _write_cancelled_rollout(rollout)

    history = load_transcript_history(rollout)

    # Physical calls only: the derivation layer appends a refinement beside the
    # vendor's tool-use, and both render as TOOL_CALL sharing one tool_use_id.
    calls = [
        fd
        for fd in history
        if fd.attributes.get("element-type") == FlowElementType.TOOL_CALL and fd.attributes.get("is-virtual") != "true"
    ]
    results = [fd for fd in history if fd.attributes.get("element-type") == FlowElementType.TOOL_RESULT]
    assert len(calls) == 1 and not results, "fixture must model an unmatched in-flight call"
    assert not any(_is_terminated_status(fd) for fd in history)


def test_abort_marker_round_trip_marks_history_terminated(tmp_path: Path):
    """record → load → merge yields exactly one terminated-turn STATUS frame
    placed after the aborted call."""
    rollout = tmp_path / "rollout.jsonl"
    _write_cancelled_rollout(rollout)
    record_dir = tmp_path / "record"

    record_turn_abort(record_dir, session_id=_SID)
    markers = load_abort_marker_frames(record_dir, session_id=_SID)
    merged = merge_abort_markers(load_transcript_history(rollout), markers)

    terminated = [fd for fd in merged if _is_terminated_status(fd)]
    assert len(terminated) == 1
    call_index = next(
        i for i, fd in enumerate(merged) if fd.attributes.get("element-type") == FlowElementType.TOOL_CALL
    )
    assert merged.index(terminated[0]) > call_index, "abort marker must replay after the aborted call"


def test_abort_marker_sorts_before_recovery_turn(tmp_path: Path):
    """A recovery turn recorded after Stop must replay AFTER the abort marker,
    so only the aborted turn's calls are terminated."""
    rollout = tmp_path / "rollout.jsonl"
    _write_cancelled_rollout(rollout, with_recovery_turn=True)
    record_dir = tmp_path / "record"
    # Abort happened between the two turns.
    _write_marker_line(record_dir, timestamp="2026-07-10T06:01:00.000Z")

    merged = merge_abort_markers(
        load_transcript_history(rollout),
        load_abort_marker_frames(record_dir, session_id=_SID),
    )

    marker_index = next(i for i, fd in enumerate(merged) if _is_terminated_status(fd))
    recovery_index = next(
        i
        for i, fd in enumerate(merged)
        if fd.attributes.get("element-type") == FlowElementType.USER_MESSAGE and "do less" in str(fd.flow_value)
    )
    call_index = next(
        i for i, fd in enumerate(merged) if fd.attributes.get("element-type") == FlowElementType.TOOL_CALL
    )
    assert call_index < marker_index < recovery_index


def test_abort_markers_filtered_by_session(tmp_path: Path):
    """A marker stamped for another session must not leak into this session's
    replay; a marker with no session id (first-turn cancel) always merges."""
    record_dir = tmp_path / "record"
    _write_marker_line(record_dir, timestamp="2026-07-10T06:01:00.000Z", session_id="other-session")
    _write_marker_line(record_dir, timestamp="2026-07-10T06:02:00.000Z", session_id="")

    frames = load_abort_marker_frames(record_dir, session_id=_SID)

    assert len(frames) == 1
    assert frames[0].created_time == "2026-07-10T06:02:00.000Z"


def test_organic_codex_turn_aborted_replay_carries_semantic_attribute(tmp_path: Path):
    """The codex TUI's own durable abort (``event_msg.turn_aborted`` in the
    rollout, written on Ctrl-C in PTY mode) must replay with the same
    vendor-neutral ``turn-terminated`` attribute as flowpad markers."""
    rollout = tmp_path / "rollout.jsonl"
    rows = [
        {"timestamp": "2026-07-10T06:00:00.000Z", "type": "session_meta", "payload": {"id": _SID, "cwd": "/repo"}},
        {
            "timestamp": "2026-07-10T06:00:02.000Z",
            "type": "event_msg",
            "payload": {"type": "turn_aborted", "reason": "user_interrupt"},
        },
    ]
    rollout.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")

    history = load_transcript_history(rollout)

    aborted = [fd for fd in history if fd.attributes.get("subtype") == "event_msg.turn_aborted"]
    assert len(aborted) == 1
    assert aborted[0].attributes.get("turn-terminated") == "true"


def test_merge_without_markers_is_identity(tmp_path: Path):
    rollout = tmp_path / "rollout.jsonl"
    _write_cancelled_rollout(rollout)
    history = load_transcript_history(rollout)

    assert merge_abort_markers(history, []) is history
    assert load_abort_marker_frames(tmp_path / "record") == []
