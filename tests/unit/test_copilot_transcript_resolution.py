from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
    copilot_transcript_path_for_process,
    load_transcript_history,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.transcript_analyzer import TranscriptFormat, TranscriptSource


@pytest.fixture()
def isolated_copilot_state(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path / "sandbox"))
    original_records = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    reset_instance_settings()
    yield get_instance_settings()
    set_default_records_root(original_records)
    reset_instance_settings()


def _process(**kwargs) -> AgenticProcess:
    return AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type=WorkerType.COPILOT,
        workdir="/repo",
        **kwargs,
    )


def _write_foreign_session(root, session_id: str):
    directory = root / session_id
    directory.mkdir(parents=True)
    (directory / "workspace.yaml").write_text('cwd: "/repo"\n', encoding="utf-8")
    events = directory / "events.jsonl"
    events.write_text(
        json.dumps({"type": "user.message", "data": {"content": "FOREIGN_HISTORY"}}) + "\n",
        encoding="utf-8",
    )
    return events


def test_preassigned_session_never_adopts_latest_foreign_history(isolated_copilot_state):
    foreign = _write_foreign_session(isolated_copilot_state.copilot_session_state_dir, "foreign-session")
    process = _process(session_id="expected-session")
    local = copilot_transcript_path_for_process(process.id)
    local.write_text('{"type":"flowpad.error","message":"own failure"}\n', encoding="utf-8")

    descriptor = process.driver.transcript_descriptor(process)

    assert descriptor is not None
    assert descriptor.path == local
    assert descriptor.path != foreign
    assert descriptor.source is TranscriptSource.PROCESS_LOCAL


def test_process_local_flowpad_error_replays_as_visible_terminal_error(tmp_path):
    transcript = tmp_path / "copilot_transcript.jsonl"
    transcript.write_text(
        '{"type":"flowpad.error","exitCode":1,"message":"bad model","stderr":"bad model"}\n',
        encoding="utf-8",
    )

    history = load_transcript_history(transcript, transcript_format=TranscriptFormat.COPILOT_STREAM)

    assert [item.attributes.get("element-type") for item in history] == [
        FlowElementType.ERROR,
        FlowElementType.END,
    ]
    assert history[0].flow_value == "bad model"
