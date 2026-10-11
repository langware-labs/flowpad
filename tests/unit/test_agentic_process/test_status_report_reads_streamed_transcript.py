"""The status report walks the transcript the streamer already holds — it never parses the file itself.

``_emit_status_report`` runs on every debounce flush of a writing agent. A
whole-file parse there is linear in the session's size (measured on a real
84.6 MB session: ~0.7-1.8 s and a 77 MB transient per report); the walk over the
streamer's live copy is milliseconds and allocates nothing.

The walk must exclude a concurrent ``parse_delta``: Claude's keep-last usage
dedup zeroes an earlier snapshot's rows IN PLACE before re-emitting them, and
those rows are the very ones the live copy has already published. So the read
goes through ``TranscriptStreamer.read`` (the streamer's own lock), and a report
that starts while a delta is being parsed waits for it and reports its result.

No mocks of the component under test: the streamer is created by the registry's
real ``notify_change`` entry point, the process is a real row re-hydrated the
way the subscriber does, and the expected numbers come from a fresh parse of
the same file.
"""

from __future__ import annotations

import asyncio
import json
import threading
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.transcript_analyzer.counters import ProcessStatusReport
from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus
from flow_sdk.transcript_streamer.registry import transcript_streamer_registry

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

_CWD = "/tmp/flowpad-status-report-streamed"
_TS = "2026-10-11T00:00:00.000Z"


def _assistant(session_id: str, message_id: str, output_tokens: int) -> dict:
    """One streaming snapshot of an assistant message; a repeated ``message_id``
    is a later snapshot of the same billed message."""
    return {
        "sessionId": session_id, "cwd": _CWD, "version": "2.0.0", "type": "assistant",
        "uuid": str(uuid.uuid4()), "timestamp": _TS,
        "message": {
            "id": message_id, "role": "assistant", "model": "claude-opus-4-7",
            "content": [{"type": "text", "text": "working"}],
            "usage": {"input_tokens": 3, "output_tokens": output_tokens,
                      "cache_read_input_tokens": 100, "cache_creation_input_tokens": 7},
        },
    }


def _append(path: Path, *lines: dict) -> None:
    with path.open("a", encoding="utf-8") as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")


def _new_session() -> tuple[str, Path]:
    session_id = str(uuid.uuid4())
    proj = get_instance_settings().claude_projects_dir / _CWD.replace("/", "-")
    proj.mkdir(parents=True, exist_ok=True)
    path = proj / f"{session_id}.jsonl"
    _append(
        path,
        {"sessionId": session_id, "cwd": _CWD, "version": "2.0.0", "type": "user",
         "uuid": str(uuid.uuid4()), "timestamp": _TS, "message": {"role": "user", "content": "go"}},
        _assistant(session_id, "msg_amended", 10),
    )
    return session_id, path


async def _running_ap(session_id: str, monkeypatch) -> AgenticProcess:
    """A RUNNING row, re-hydrated the way the subscriber hydrates one per event."""
    ap = AgenticProcess(id=str(uuid.uuid4()), session_id=session_id, worker_type=WorkerType.CLAUDE_CODE)
    ap.status = ProcessStatus.RUNNING.value
    ap.pty_mode = True
    await ap.save(notify=False)

    async def _no_push(self, flow_data):
        return None

    monkeypatch.setattr(AgenticProcess, "emit_flow_data", _no_push, raising=False)
    fresh = await AgenticProcess.get_by_id(str(ap.id))
    assert fresh is not None
    return fresh


def _fresh_parse_report(path: Path) -> dict:
    """What a whole-file parse of ``path`` reports — the reference the walk must equal."""
    return ProcessStatusReport.from_transcript(
        AgentTranscriptFile("claude", path),
        worker_status=WorkerStatus.THINKING.value,
        process_status=ProcessStatus.RUNNING.value,
        busy=True,
    ).model_dump()


def _forbid_whole_file_parse(monkeypatch) -> None:
    def _no_whole_file_parse(self, descriptor=None):
        raise AssertionError("the status report re-parsed the whole transcript")

    monkeypatch.setattr(AgenticProcess, "_load_transcript", _no_whole_file_parse)


@pytest.mark.asyncio
async def test_status_report_walks_the_streamers_transcript_without_parsing(initialize_test_db, monkeypatch) -> None:
    session_id, path = _new_session()
    ap = await _running_ap(session_id, monkeypatch)
    await transcript_streamer_registry.notify_change(path)
    assert transcript_streamer_registry.get_streamer_by_path(path) is not None
    _forbid_whole_file_parse(monkeypatch)
    try:
        await ap._emit_status_report(WorkerStatus.THINKING, True)

        assert ap.status_report == _fresh_parse_report(path)
        assert ap.status_report["counters"]["output_tokens"] == 10
    finally:
        transcript_streamer_registry.remove_by_path(path)


@pytest.mark.asyncio
async def test_totals_stay_exact_when_a_message_is_amended_across_two_deltas(initialize_test_db, monkeypatch) -> None:
    """The second snapshot of ``msg_amended`` arrives in a later delta and
    supersedes the first: the report counts the message once, at its last size."""
    session_id, path = _new_session()
    ap = await _running_ap(session_id, monkeypatch)
    await transcript_streamer_registry.notify_change(path)
    _forbid_whole_file_parse(monkeypatch)
    try:
        await ap._emit_status_report(WorkerStatus.THINKING, True)
        assert ap.status_report["counters"]["output_tokens"] == 10

        _append(path, _assistant(session_id, "msg_amended", 25))
        await transcript_streamer_registry.notify_change(path)
        await ap._emit_status_report(WorkerStatus.THINKING, True)

        assert ap.status_report["counters"]["output_tokens"] == 25
        assert ap.status_report == _fresh_parse_report(path)
    finally:
        transcript_streamer_registry.remove_by_path(path)


@pytest.mark.asyncio
async def test_a_report_started_during_a_delta_parse_waits_for_it(initialize_test_db, monkeypatch) -> None:
    """A flush that lands while ``parse_delta`` is in flight neither deadlocks
    nor reads the transcript mid-rewrite: it reports the totals that delta
    leaves behind."""
    session_id, path = _new_session()
    ap = await _running_ap(session_id, monkeypatch)
    await transcript_streamer_registry.notify_change(path)
    streamer = transcript_streamer_registry.get_streamer_by_path(path)
    assert streamer is not None
    _forbid_whole_file_parse(monkeypatch)

    # Hold the real parse open inside the streamer's worker thread, lock held.
    parsing, proceed = threading.Event(), threading.Event()
    real_parse_delta = streamer.transcript.parse_delta

    def _held_parse_delta():
        parsing.set()
        proceed.wait()
        return real_parse_delta()

    monkeypatch.setattr(streamer.transcript, "parse_delta", _held_parse_delta)
    try:
        _append(path, _assistant(session_id, "msg_amended", 25))
        delta = asyncio.create_task(transcript_streamer_registry.notify_change(path))
        await asyncio.to_thread(parsing.wait)
        assert streamer._lock.locked()

        report = asyncio.create_task(ap._emit_status_report(WorkerStatus.THINKING, True))
        for _ in range(20):  # let the report run as far as it can
            await asyncio.sleep(0)
        assert not report.done(), "the report read the transcript while a delta was being parsed"
        assert not ap.status_report

        proceed.set()
        await asyncio.gather(delta, report)

        assert ap.status_report["counters"]["output_tokens"] == 25
        assert ap.status_report == _fresh_parse_report(path)
    finally:
        proceed.set()
        transcript_streamer_registry.remove_by_path(path)
