from __future__ import annotations

import json
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers import AgenticProcessContextKey
from flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history import (
    codex_transcript_path_for_process,
    load_transcript_history,
)
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.server.routes.transcripts import get_worker_session_transcript
from flow_sdk.transcript_analyzer import TranscriptFormat, TranscriptSource
from flow_sdk.transcript_analyzer.resolver import (
    received_transcript_dest,
    resolve_session_jsonl,
)


@pytest.fixture()
def isolated_codex_home(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path / "sandbox"))
    reset_instance_settings()
    yield get_instance_settings()
    reset_instance_settings()


@pytest.fixture()
def isolated_records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield
    set_default_records_root(original)


def _process(**kwargs) -> AgenticProcess:
    return AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type=WorkerType.CODEX,
        workdir="/repo",
        **kwargs,
    )


def _write_rollout(
    sessions_root: Path,
    *,
    thread_id: str,
    cwd: str,
    prompt: str = "Implement the rollout prompt.",
    timestamp: str = "2026-05-06T21:39:48.000Z",
) -> Path:
    path = sessions_root / "2026" / "05" / "06" / f"rollout-2026-05-06T21-39-48-{thread_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join([
            (
                '{"timestamp":"%s","type":"session_meta","payload":'
                '{"id":"%s","timestamp":"%s","cwd":"%s","cli_version":"0.101.0"}}'
            ) % (timestamp, thread_id, timestamp, cwd),
            (
                '{"timestamp":"%s","type":"response_item","payload":'
                '{"type":"message","role":"user","content":[{"type":"input_text","text":"%s"}]}}'
            ) % (timestamp, prompt),
            (
                '{"timestamp":"%s","type":"response_item","payload":'
                '{"type":"message","role":"assistant","phase":"final_answer",'
                '"content":[{"type":"output_text","text":"Done."}]}}'
            ) % timestamp,
        ])
        + "\n",
        encoding="utf-8",
    )
    return path


def test_codex_history_replays_all_durable_typed_entries(tmp_path):
    timestamps = [f"2026-07-10T06:00:00.{index:03d}Z" for index in range(12)]
    rows = [
        {
            "timestamp": timestamps[0],
            "type": "session_meta",
            "payload": {"id": "session-1", "cwd": "/repo"},
        },
        {
            "timestamp": timestamps[1],
            "type": "turn_context",
            "payload": {"model": "gpt-test", "turn_id": "turn-1"},
        },
        {
            "timestamp": timestamps[2],
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": "developer-1",
                "role": "developer",
                "content": [{"type": "input_text", "text": "policy"}],
            },
        },
        {
            "timestamp": timestamps[3],
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": "user-1",
                "role": "user",
                "content": [{"type": "input_text", "text": "prompt"}],
            },
        },
        {
            "timestamp": timestamps[4],
            "type": "response_item",
            "payload": {
                "type": "reasoning",
                "id": "reasoning-1",
                "summary": [{"type": "summary_text", "text": "thinking"}],
            },
        },
        {
            "timestamp": timestamps[5],
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": "commentary-1",
                "role": "assistant",
                "phase": "commentary",
                "content": [{"type": "output_text", "text": "working"}],
            },
        },
        {
            "timestamp": timestamps[6],
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "id": "call-entry-1",
                "name": "exec_command",
                "call_id": "call-1",
                "arguments": json.dumps({"cmd": "printf ok"}),
            },
        },
        {
            "timestamp": timestamps[7],
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "id": "result-entry-1",
                "call_id": "call-1",
                "output": (
                    "Wall time: 0.01 seconds\nProcess exited with code 0\n"
                    "Output:\nok"
                ),
            },
        },
        {
            "timestamp": timestamps[8],
            "type": "event_msg",
            "payload": {"type": "error", "message": "recoverable"},
        },
        {
            "timestamp": timestamps[9],
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "turn_id": "turn-1",
                    "total_token_usage": {
                        "input_tokens": 100,
                        "cached_input_tokens": 40,
                        "output_tokens": 20,
                    },
                },
            },
        },
        {
            "timestamp": timestamps[10],
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": "final-1",
                "role": "assistant",
                "phase": "final_answer",
                "content": [{"type": "output_text", "text": "done"}],
            },
        },
        {
            "timestamp": timestamps[11],
            "type": "event_msg",
            "payload": {"type": "task_complete", "turn_id": "turn-1"},
        },
    ]
    rollout = tmp_path / "rollout-session-1.jsonl"
    rollout.write_text(
        "".join(json.dumps(row) + "\n" for row in rows),
        encoding="utf-8",
    )

    history = load_transcript_history(rollout)
    transcript_entries = [item.process_entry["transcript_entry"] for item in history]

    assert len(history) == 14
    assert {entry["kind"] for entry in transcript_entries} == {
        "assistant_message",
        "system",
        "token_usage",
        "tool_result",
        "tool_use",
        "user_message",
    }
    assert "meta" not in {entry["kind"] for entry in transcript_entries}
    assert all(item.process_entry["observation_kind"] == "replay" for item in history)
    assert all(item.created_time in timestamps[1:] for item in history)

    subtypes = {item.attributes["subtype"] for item in history}
    assert {
        "developer_message",
        "event_msg.error",
        "event_msg.task_complete",
        "turn_context",
    } <= subtypes
    developer = next(
        item
        for item in history
        if item.attributes["subtype"] == "developer_message"
    )
    assert developer.attributes["element-type"] == "status"

    assert [
        item.attributes.get("phase")
        for item in history
        if item.attributes.get("phase")
    ] == ["commentary", "final_answer"]
    tool_call = next(item for item in history if item.attributes["subtype"] == "tool_use")
    tool_result = next(
        item for item in history if item.attributes["subtype"] == "tool_result"
    )
    assert tool_call.flow_value["tool_call_id"] == "call-1"
    assert tool_result.attributes["tool-use-id"] == "call-1"
    assert tool_result.attributes["tool-name"] == "exec_command"
    usage = [
        entry
        for entry in transcript_entries
        if entry["kind"] == "token_usage"
    ]
    assert [entry["count"] for entry in usage] == [60, 20, 40, 0]


def test_codex_visible_resolves_rollout_by_session_id(isolated_codex_home):
    thread_id = "019dfe96-cc36-7d80-a907-de19575a6ea4"
    rollout = _write_rollout(
        isolated_codex_home.codex_sessions_dir,
        thread_id=thread_id,
        cwd="/repo",
    )
    proc = _process(visible=True, session_id=thread_id)

    descriptor = proc.driver.transcript_descriptor(proc)

    assert descriptor is not None
    assert descriptor.path == rollout
    assert descriptor.format is TranscriptFormat.CODEX_ROLLOUT
    assert descriptor.source is TranscriptSource.WORKER_SESSION
    assert descriptor.session_id == thread_id


def test_codex_visible_discovers_rollout_by_cwd_and_launch_time(isolated_codex_home):
    thread_id = "019dfe96-cc36-7d80-a907-de19575a6ea4"
    rollout = _write_rollout(
        isolated_codex_home.codex_sessions_dir,
        thread_id=thread_id,
        cwd="/repo",
        timestamp="2026-05-06T21:40:00.000Z",
    )
    proc = _process(
        visible=True,
        session_id="flowpad-preassigned",
        context_data={
            AgenticProcessContextKey.WORKER_STARTED_AT.value: "2026-05-06T21:39:48.000Z",
        },
    )

    descriptor = proc.driver.transcript_descriptor(proc)

    assert descriptor is not None
    assert descriptor.path == rollout
    assert descriptor.format is TranscriptFormat.CODEX_ROLLOUT
    assert descriptor.session_id == thread_id


def test_codex_headless_prefers_rollout_over_process_local_stream(
    isolated_codex_home, isolated_records_root
):
    # New contract (commit 624ddb89): the rollout is the canonical record for BOTH
    # transports — headless no longer prefers the process-local stdout tee (that tee
    # carries assistant output only, no user-message entry, so transcript/prompts
    # came back empty for headless). With a rollout present, even a headless
    # (visible=False) process resolves to it; the stdout tee is only the fallback
    # before codex mints/captures its rollout id.
    thread_id = "019dfe96-cc36-7d80-a907-de19575a6ea4"
    rollout = _write_rollout(isolated_codex_home.codex_sessions_dir, thread_id=thread_id, cwd="/repo")
    proc = _process(visible=False, session_id=thread_id)
    local = codex_transcript_path_for_process(proc.id)
    local.write_text(
        '{"type":"thread.started","thread_id":"%s","timestamp":"2026-05-06T21:39:48.000Z"}\n'
        % thread_id,
        encoding="utf-8",
    )

    descriptor = proc.driver.transcript_descriptor(proc)

    assert descriptor is not None
    assert descriptor.path == rollout
    assert descriptor.format is TranscriptFormat.CODEX_ROLLOUT
    assert descriptor.source is TranscriptSource.WORKER_SESSION


@pytest.mark.asyncio
async def test_transcript_prompts_uses_visible_codex_rollout(isolated_codex_home):
    thread_id = "019dfe96-cc36-7d80-a907-de19575a6ea4"
    _write_rollout(
        isolated_codex_home.codex_sessions_dir,
        thread_id=thread_id,
        cwd="/repo",
        prompt="Return the canonical prompt.",
    )
    proc = _process(visible=True, session_id="flowpad-preassigned", status=ProcessStatus.NEW.value)

    req = MagicMock()
    req.sub_path = "prompts"
    save_mock = AsyncMock()
    with patch.object(AgenticProcess, "save", save_mock), patch(
        "flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info",
        return_value=req,
    ):
        result = await proc.transcript_action()

    assert proc.session_id == thread_id
    save_mock.assert_awaited_once()
    assert result.data["prompts"][0]["text"] == "Return the canonical prompt."


@pytest.mark.asyncio
async def test_transcript_full_returns_descriptor_metadata(isolated_codex_home):
    thread_id = "019dfe96-cc36-7d80-a907-de19575a6ea4"
    rollout = _write_rollout(isolated_codex_home.codex_sessions_dir, thread_id=thread_id, cwd="/repo")
    proc = _process(visible=True, session_id=thread_id)

    req = MagicMock()
    req.sub_path = "full"
    with patch(
        "flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info",
        return_value=req,
    ):
        result = await proc.transcript_action()

    assert result.data["path"] == str(rollout)
    assert result.data["transcript_format"] == TranscriptFormat.CODEX_ROLLOUT.value
    assert result.data["transcript_source"] == TranscriptSource.WORKER_SESSION.value
    assert result.data["session_id"] == thread_id
    assert any(entry["kind"] == "user_message" for entry in result.data["entries"])


@pytest.mark.asyncio
async def test_worker_transcript_route_uses_configured_codex_home(
    tmp_path, monkeypatch
):
    thread_id = "019dfe96-cc36-7d80-a907-de19575a6ea4"
    configured_home = tmp_path / "configured-codex"
    ambient_home = tmp_path / "ambient-home"
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path / "sandbox"))
    monkeypatch.setenv("CODEX_HOME", str(configured_home))
    reset_instance_settings()
    try:
        configured = _write_rollout(
            get_instance_settings().codex_sessions_dir,
            thread_id=thread_id,
            cwd="/configured",
            prompt="Configured-home prompt.",
        )
        _write_rollout(
            ambient_home / ".codex" / "sessions",
            thread_id=thread_id,
            cwd="/ambient",
            prompt="Ambient-home prompt.",
        )
        monkeypatch.setenv("HOME", str(ambient_home))

        response = await get_worker_session_transcript("codex", thread_id)

        assert response["ok"] is True
        assert response["path"] == str(configured)
        assert response["header"]["cwd"] == "/configured"
        assert any(
            entry.get("text") == "Configured-home prompt."
            for entry in response["entries"]
        )
    finally:
        reset_instance_settings()


@pytest.mark.parametrize("session_id", ["*", "../outside", "nested/session", "bad\\id"])
def test_session_resolution_rejects_unsafe_path_components(
    isolated_codex_home, session_id
):
    with pytest.raises(ValueError, match="filename-safe component"):
        resolve_session_jsonl("codex", session_id)
    assert received_transcript_dest("codex", session_id) is None
