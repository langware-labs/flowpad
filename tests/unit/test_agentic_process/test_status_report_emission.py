"""AgenticProcess._emit_status_report builds the ProcessStatusReport projection
from the transcript, persists it (change-gated), and pushes it on the shared
``progress_report`` flow_data envelope. _derive_focused_asset points at the most
recent plan/doc as a URL-ref pointer.

Numbers are the same laser-accurate fixture totals asserted in
tests/unit/test_transcript_analyzer/test_process_counters.py — this test proves
the orchestrator wiring streams exactly those numbers.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.transcript_analyzer.entries.file_write import FileWriteEntry
from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile

pytestmark = pytest.mark.timeout(30)

_RESOURCES = Path(__file__).resolve().parent.parent / "resources" / "transcripts"


def _make_ap() -> AgenticProcess:
    return AgenticProcess(
        id=mint_uuid(),
        session_id="00000000-0000-0000-0000-000000000010",
        worker_type=WorkerType.CLAUDE_CODE,
        status="running",
    )


@pytest.mark.asyncio
async def test_emit_status_report_streams_exact_counters(initialize_test_db, monkeypatch) -> None:
    ap = _make_ap()
    await ap.save()
    t = AgentTranscriptFile("claude", _RESOURCES / "claude_multi_block_message.jsonl")
    monkeypatch.setattr(type(ap), "_load_transcript", lambda self, d=None: t, raising=False)

    pushed: list[dict] = []

    async def _capture_flow(self, flow_data):
        pushed.append(flow_data)
    monkeypatch.setattr(type(ap), "emit_flow_data", _capture_flow, raising=False)

    await ap._emit_status_report(WorkerStatus.THINKING, True)

    # Persisted snapshot mirrors the exact fixture totals.
    counters = ap.status_report["counters"]
    assert counters["input_tokens"] == 8
    assert counters["output_tokens"] == 4331
    assert counters["cache_read_tokens"] == 215526
    assert counters["cache_write_tokens"] == 3941
    assert counters["assistant_messages"] == 3
    assert ap.status_report["worker_status"] == WorkerStatus.THINKING.value
    # process_status is the lifecycle FSM verbatim (``running`` — no projection);
    # turn-in-flight rides the separate ``busy`` boolean.
    assert ap.status_report["process_status"] == "running"
    assert ap.status_report["busy"] is True

    # Pushed on the reused progress_report envelope, kind-discriminated.
    assert len(pushed) == 1
    attrs = pushed[0]["attributes"]
    assert attrs["element-type"] == "progress_report"
    assert attrs["kind"] == "process_status"
    assert pushed[0]["flow_value"]["counters"]["output_tokens"] == 4331


@pytest.mark.asyncio
async def test_emit_status_report_is_change_gated(initialize_test_db, monkeypatch) -> None:
    """An unchanged report neither re-saves nor re-pushes."""
    ap = _make_ap()
    await ap.save()
    t = AgentTranscriptFile("claude", _RESOURCES / "claude_multi_block_message.jsonl")
    monkeypatch.setattr(type(ap), "_load_transcript", lambda self, d=None: t, raising=False)

    writes = {"n": 0}
    update_existing = ap._db.update_existing_data_field

    async def _count_update(*args, **kwargs):
        writes["n"] += 1
        return await update_existing(*args, **kwargs)

    monkeypatch.setattr(ap._db, "update_existing_data_field", _count_update)

    pushed: list[dict] = []

    async def _capture_flow(self, flow_data):
        pushed.append(flow_data)
    monkeypatch.setattr(type(ap), "emit_flow_data", _capture_flow, raising=False)

    await ap._emit_status_report(WorkerStatus.THINKING, True)
    await ap._emit_status_report(WorkerStatus.THINKING, True)  # identical → no-op

    assert writes["n"] == 1
    assert len(pushed) == 1


@pytest.mark.asyncio
async def test_delayed_status_report_does_not_resurrect_deleted_process(initialize_test_db, monkeypatch) -> None:
    ap = _make_ap()
    await ap.save()
    stale = await AgenticProcess.get_by_id(str(ap.id))
    assert stale is not None
    await ap.delete()

    t = AgentTranscriptFile("claude", _RESOURCES / "claude_multi_block_message.jsonl")
    monkeypatch.setattr(type(stale), "_load_transcript", lambda self, d=None: t, raising=False)
    pushed: list[dict] = []

    async def _capture_flow(self, flow_data):
        pushed.append(flow_data)

    monkeypatch.setattr(type(stale), "emit_flow_data", _capture_flow, raising=False)
    await stale._emit_status_report(WorkerStatus.TOOL_CALL, True)

    assert pushed == []
    assert await AgenticProcess.get_by_id(str(ap.id)) is None


def _entry(path: str, eid: str) -> FileWriteEntry:
    return FileWriteEntry(
        path=path, tool_name="Write",
        id=eid, session_id="s", timestamp="2026-05-23T00:00:00Z", worker="claude",
    )


def test_derive_focused_asset_points_at_latest_user_doc() -> None:
    ap = _make_ap()
    transcript = SimpleNamespace(entries=[
        _entry("/tmp/first.md", "e1"),
        _entry("/tmp/latest.md", "e2"),
    ])
    fa = ap._derive_focused_asset(transcript)
    assert fa is not None
    assert fa.asset_type == "markdown"
    assert fa.ref_type == "vfs"
    assert fa.ref_value == "/tmp/latest.md"  # most-recent-wins


def test_derive_focused_asset_none_without_asset_entries() -> None:
    ap = _make_ap()
    assert ap._derive_focused_asset(SimpleNamespace(entries=[])) is None
