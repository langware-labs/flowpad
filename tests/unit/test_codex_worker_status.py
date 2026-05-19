"""Codex worker status consolidation tests.

These cover both Codex transcript sources:
- process-local stream JSONL from ``codex exec --json``;
- global rollout JSONL from visible/open Codex TUI sessions.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess, ProcessStatus, WorkerStatus
from flow_sdk.builtin.agentic_process.cli_drivers.codex.driver import CodexDriver
from flow_sdk.builtin.agentic_process.cli_drivers.codex.status import codex_tail_status
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import reset_instance_settings


@pytest.fixture()
def isolated_instance_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    codex_home = tmp_path / ".codex"
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    monkeypatch.setenv("FS_RECORD_PATH", str(tmp_path / "records"))
    reset_instance_settings()
    yield codex_home
    reset_instance_settings()


def _write_jsonl(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")


def _rollout_path(codex_home: Path, session_id: str) -> Path:
    return codex_home / "sessions" / "2026" / "03" / "11" / (
        f"rollout-2026-03-11T17-02-01-{session_id}.jsonl"
    )


def test_codex_stream_turn_completed_is_complete(tmp_path: Path):
    transcript = tmp_path / "codex_stream.jsonl"
    _write_jsonl(transcript, [
        {"type": "thread.started", "thread_id": "sid"},
        {"type": "turn.started"},
        {"type": "item.started", "item": {"type": "agent_message"}},
        {"type": "turn.completed"},
    ])

    assert codex_tail_status(transcript) == WorkerStatus.COMPLETE


def test_codex_rollout_task_complete_is_complete(tmp_path: Path):
    transcript = tmp_path / "rollout.jsonl"
    _write_jsonl(transcript, [
        {"type": "session_meta", "payload": {"id": "sid", "cwd": "/repo"}},
        {"type": "event_msg", "payload": {"type": "task_started"}},
        {"type": "event_msg", "payload": {"type": "task_complete"}},
    ])

    assert codex_tail_status(transcript) == WorkerStatus.COMPLETE


def test_codex_rollout_final_answer_is_complete_even_when_stale(tmp_path: Path):
    transcript = tmp_path / "rollout.jsonl"
    _write_jsonl(transcript, [
        {"type": "session_meta", "payload": {"id": "sid", "cwd": "/repo"}},
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "phase": "final_answer",
                "content": [{"type": "output_text", "text": "done"}],
            },
        },
        {"type": "event_msg", "payload": {"type": "token_count"}},
    ])
    old = time.time() - 900
    os.utime(transcript, (old, old))

    assert codex_tail_status(transcript) == WorkerStatus.COMPLETE


def test_codex_rollout_user_message_is_waiting_when_active(tmp_path: Path):
    transcript = tmp_path / "rollout.jsonl"
    _write_jsonl(transcript, [
        {"type": "session_meta", "payload": {"id": "sid", "cwd": "/repo"}},
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "work"}],
            },
        },
    ])

    assert codex_tail_status(transcript) == WorkerStatus.WAITING


def test_codex_rollout_tool_begin_is_tool_running_when_active(tmp_path: Path):
    transcript = tmp_path / "rollout.jsonl"
    _write_jsonl(transcript, [
        {"type": "session_meta", "payload": {"id": "sid", "cwd": "/repo"}},
        {"type": "event_msg", "payload": {"type": "exec_command_begin", "call_id": "call-1"}},
    ])

    assert codex_tail_status(transcript) == WorkerStatus.TOOL_RUNNING


def test_codex_rollout_tool_call_is_tool_call_when_active(tmp_path: Path):
    transcript = tmp_path / "rollout.jsonl"
    _write_jsonl(transcript, [
        {"type": "session_meta", "payload": {"id": "sid", "cwd": "/repo"}},
        {
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "shell",
                "call_id": "call-1",
                "arguments": "{}",
            },
        },
    ])

    assert codex_tail_status(transcript) == WorkerStatus.TOOL_CALL


def test_codex_rollout_stale_nonterminal_signal_is_inactive(tmp_path: Path):
    transcript = tmp_path / "rollout.jsonl"
    _write_jsonl(transcript, [
        {"type": "session_meta", "payload": {"id": "sid", "cwd": "/repo"}},
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "work"}],
            },
        },
    ])
    old = time.time() - 900
    os.utime(transcript, (old, old))

    assert codex_tail_status(transcript) == WorkerStatus.INACTIVE


def test_codex_driver_falls_back_to_rollout_by_session_id(isolated_instance_paths: Path):
    session_id = "019cdd6b-49a7-7480-9da1-aaaaaaaaaaaa"
    rollout = _rollout_path(isolated_instance_paths, session_id)
    _write_jsonl(rollout, [
        {"type": "session_meta", "payload": {"id": session_id, "cwd": "/repo"}},
        {"type": "event_msg", "payload": {"type": "task_complete"}},
    ])
    proc = AgenticProcess(worker_type=WorkerType.CODEX, session_id=session_id)

    assert CodexDriver().transcript_path(proc) == rollout


def test_codex_driver_falls_back_to_recent_rollout_by_workdir(
    isolated_instance_paths: Path,
    tmp_path: Path,
):
    workdir = tmp_path / "repo"
    workdir.mkdir()
    real_session_id = "019cdd6b-49a7-7480-9da1-bbbbbbbbbbbb"
    rollout = _rollout_path(isolated_instance_paths, real_session_id)
    _write_jsonl(rollout, [
        {
            "type": "session_meta",
            "payload": {"id": real_session_id, "cwd": str(workdir)},
        },
        {"type": "event_msg", "payload": {"type": "task_started"}},
    ])
    proc = AgenticProcess(
        worker_type=WorkerType.CODEX,
        session_id="flowpad-preassigned-session-id",
        workdir=str(workdir),
    )
    proc.updated_date = datetime.now(tz=timezone.utc)

    assert CodexDriver().transcript_path(proc) == rollout


def test_agentic_process_running_missing_transcript_is_initializing(
    isolated_instance_paths: Path,
):
    proc = AgenticProcess(worker_type=WorkerType.CODEX, session_id="missing")
    proc.status = ProcessStatus.RUNNING.value

    assert proc._discover_status_from_transcript() == WorkerStatus.INITIALIZING
