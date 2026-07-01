from __future__ import annotations

import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers import AgenticProcessContextKey
from flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history import (
    codex_transcript_path_for_process,
)
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.transcript_analyzer import TranscriptFormat, TranscriptSource


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
