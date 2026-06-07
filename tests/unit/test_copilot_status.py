"""Copilot transcript tail-status mapping."""

import json
from pathlib import Path

from flow_sdk.builtin.agentic_process.cli_drivers.copilot.status import copilot_tail_status
from flow_sdk.builtin.worker_status import WorkerStatus

_RESOURCES = Path(__file__).resolve().parent / "resources" / "transcripts"


def test_result_zero_is_complete():
    assert copilot_tail_status(_RESOURCES / "copilot_stream_stdin_prompt.jsonl") == WorkerStatus.COMPLETE


def test_bad_model_nonzero_without_result_is_error(tmp_path):
    path = tmp_path / "bad_model_with_adapter_error.jsonl"
    content = (_RESOURCES / "copilot_stream_bad_model.jsonl").read_text(encoding="utf-8")
    marker = {"type": "flowpad.error", "exitCode": 1, "message": "bad model"}
    path.write_text(content + json.dumps(marker) + "\n", encoding="utf-8")

    assert copilot_tail_status(path) == WorkerStatus.ERROR


def test_interrupted_marker_is_interrupted(tmp_path):
    path = tmp_path / "interrupted.jsonl"
    path.write_text(json.dumps({"type": "flowpad.interrupted"}) + "\n", encoding="utf-8")

    assert copilot_tail_status(path) == WorkerStatus.INTERRUPTED


def test_tool_execution_start_is_tool_running(tmp_path):
    path = tmp_path / "running.jsonl"
    path.write_text(json.dumps({"type": "tool.execution_start", "data": {"toolName": "bash"}}) + "\n", encoding="utf-8")

    assert copilot_tail_status(path) == WorkerStatus.TOOL_RUNNING
