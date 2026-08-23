"""``opencode_tail_status`` — transcript tail → WorkerStatus."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from flow_sdk.builtin.agentic_process.cli_drivers.opencode.status import opencode_tail_status
from flow_sdk.builtin.worker_status import WorkerStatus

_RESOURCES = Path(__file__).resolve().parent / "resources" / "transcripts"


def _write(tmp_path: Path, *events: dict) -> Path:
    path = tmp_path / "tee.jsonl"
    path.write_text(
        "".join(json.dumps(e, separators=(",", ":")) + "\n" for e in events),
        encoding="utf-8",
    )
    return path


def _step_finish(reason: str) -> dict:
    return {"type": "step_finish", "sessionID": "ses_x", "part": {"type": "step-finish", "reason": reason}}


def test_missing_file_is_initializing(tmp_path):
    assert opencode_tail_status(tmp_path / "nope.jsonl") == WorkerStatus.INITIALIZING


def test_empty_file_is_initializing(tmp_path):
    path = tmp_path / "empty.jsonl"
    path.write_text("", encoding="utf-8")
    assert opencode_tail_status(path) == WorkerStatus.INITIALIZING


def test_stop_reason_is_complete(tmp_path):
    assert opencode_tail_status(_write(tmp_path, _step_finish("stop"))) == WorkerStatus.COMPLETE


def test_tool_calls_reason_is_not_terminal(tmp_path):
    """``tool-calls`` means the loop continues — it must not read as COMPLETE."""
    assert opencode_tail_status(_write(tmp_path, _step_finish("tool-calls"))) == WorkerStatus.THINKING


def test_running_tool_is_tool_running(tmp_path):
    event = {
        "type": "tool_use",
        "sessionID": "ses_x",
        "part": {"tool": "bash", "state": {"status": "running"}},
    }
    assert opencode_tail_status(_write(tmp_path, event)) == WorkerStatus.TOOL_RUNNING


def test_completed_tool_is_thinking(tmp_path):
    event = {
        "type": "tool_use",
        "sessionID": "ses_x",
        "part": {"tool": "bash", "state": {"status": "completed"}},
    }
    assert opencode_tail_status(_write(tmp_path, event)) == WorkerStatus.THINKING


def test_interrupted_is_terminal(tmp_path):
    path = _write(tmp_path, {"type": "flowpad.interrupted", "sessionID": "ses_x"})
    assert opencode_tail_status(path) == WorkerStatus.INTERRUPTED


def test_error_is_terminal(tmp_path):
    assert opencode_tail_status(_write(tmp_path, {"type": "error"})) == WorkerStatus.ERROR


def test_synthetic_result_closes_a_turn_that_printed_no_step_finish(tmp_path):
    """Upstream #26855: a clean exit can omit the final ``step_finish``. The
    worker writes its own terminal so status can still settle."""
    path = _write(
        tmp_path,
        {"type": "text", "sessionID": "ses_x", "part": {"type": "text", "text": "hi"}},
        {"type": "flowpad.result", "sessionID": "ses_x", "exitCode": 0},
    )
    assert opencode_tail_status(path) == WorkerStatus.COMPLETE


def test_nonzero_synthetic_result_is_error(tmp_path):
    path = _write(tmp_path, {"type": "flowpad.result", "sessionID": "ses_x", "exitCode": 3})
    assert opencode_tail_status(path) == WorkerStatus.ERROR


def test_terminal_beats_a_stale_mtime(tmp_path):
    path = _write(tmp_path, _step_finish("stop"))
    stale = time.time() - 3600
    os.utime(path, (stale, stale))
    assert opencode_tail_status(path) == WorkerStatus.COMPLETE


def test_non_terminal_tail_goes_inactive_when_stale(tmp_path):
    path = _write(tmp_path, {"type": "text", "sessionID": "ses_x", "part": {"type": "text", "text": "hi"}})
    stale = time.time() - 3600
    os.utime(path, (stale, stale))
    assert opencode_tail_status(path) == WorkerStatus.INACTIVE


def test_parseable_but_unmapped_tail_is_unknown_never_running(tmp_path):
    path = _write(tmp_path, {"type": "some.future.event", "sessionID": "ses_x"})
    assert opencode_tail_status(path) == WorkerStatus.UNKNOWN


def test_real_capture_ends_complete():
    path = _RESOURCES / "opencode_stream_hello.jsonl"
    assert opencode_tail_status(path) == WorkerStatus.COMPLETE
