"""A cached transcript resolution must never change what a process reports.

Companion to ``test_transcript_cache_no_repeat_search.py`` (which proves the
cache saves the search). Here every step of a real transcript lifecycle is
serialized twice — once with whatever the cache holds from the previous steps,
once after ``transcript_cache.clear()`` — and the status fields the UI reads
must be identical. The steps are the moments the explore found a transcript's
path legitimately moves, per worker: the file appearing after spawn, a session
rotation, a Codex tee superseded by its rollout, a Codex relaunch, Copilot's
tee/session-record flip, OpenCode's store-backed projection, deletion, and
recovery of a stopped process. Real files, real drivers; nothing is mocked.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess, transcript_cache
from flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history import codex_transcript_path_for_process
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import copilot_transcript_path_for_process
from flow_sdk.flowpad_types.enums import WorkerType

from .test_codex_transcript_resolution import _write_rollout
from .test_opencode_live_transcript_freshness import _add_turn
from .test_transcript_cache_no_repeat_search import process as _proc
from .test_transcript_cache_no_repeat_search import view, write_copilot_events


def _assert_parity(process: AgenticProcess, *, after_warm=None) -> dict:
    """Serialize warm (cache as left by earlier steps), then cold; they must agree.

    Compares the resolved file too: two candidate transcripts can carry the same
    status while one of them is stale. ``after_warm`` runs between the two, for
    checks that must observe the warm serialization's side effects.
    """
    warm = {**view(process), "path": process.transcript_path}
    if after_warm is not None:
        after_warm()
    transcript_cache.clear()
    cold = {**view(process), "path": process.transcript_path}
    assert warm == cold, f"cached resolution changed what the process reports:\n warm={warm}\n cold={cold}"
    return cold


def _claude_lines(path: Path, *entries: dict) -> None:
    with path.open("a", encoding="utf-8") as fh:
        for entry in entries:
            fh.write(json.dumps(entry) + "\n")
    os.utime(path, None)


_USER = {"type": "user", "message": {"role": "user", "content": "hi"}}
_THINKING = {"type": "assistant", "message": {"role": "assistant", "stop_reason": None, "content": []}}
_DONE = {"type": "assistant", "message": {"role": "assistant", "stop_reason": "end_turn", "content": []}}
# Claude Code's synthetic error entry — the shape ``tail_status_detail`` recovers the sentence from.
_ERROR = {
    "type": "assistant",
    "isApiErrorMessage": True,
    "uuid": "err-1",
    "message": {
        "role": "assistant",
        "stop_reason": "stop_sequence",
        "content": [{"type": "text", "text": "Not logged in · Please run /login"}],
    },
}


# ── Claude ────────────────────────────────────────────────────────────────────


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_claude_file_appears_after_spawn(worker_session_stores):
    stores = worker_session_stores
    process = _proc(WorkerType.CLAUDE_CODE, session_id=str(uuid.uuid4()))
    assert view(process)["worker_status"] is None
    _claude_lines(stores.claude_repo / f"{process.session_id}.jsonl", _USER, _THINKING)
    assert _assert_parity(process)["worker_status"] is not None


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_claude_turn_progress_in_the_same_file(worker_session_stores):
    stores = worker_session_stores
    process = _proc(WorkerType.CLAUDE_CODE, session_id=str(uuid.uuid4()))
    path = stores.claude_repo / f"{process.session_id}.jsonl"
    _claude_lines(path, _USER, _THINKING)
    before = view(process)
    _claude_lines(path, _DONE)
    after = _assert_parity(process)
    assert before["worker_status"] != after["worker_status"]


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_claude_session_rotation_follows_the_new_session(worker_session_stores):
    stores = worker_session_stores
    process = _proc(WorkerType.CLAUDE_CODE, session_id=str(uuid.uuid4()))
    _claude_lines(stores.claude_repo / f"{process.session_id}.jsonl", _USER, _DONE)
    before = view(process)
    rotated = str(uuid.uuid4())
    _claude_lines(stores.claude_repo / f"{rotated}.jsonl", _USER, _ERROR)
    process.adopt_worker_session(rotated)
    after = _assert_parity(process)
    assert before["worker_status"] != after["worker_status"]
    assert after["worker_status_detail"], "the rotated session's ERROR detail must be read from the new file"


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_claude_deleted_transcript_stops_reporting(worker_session_stores):
    stores = worker_session_stores
    process = _proc(WorkerType.CLAUDE_CODE, session_id=str(uuid.uuid4()))
    path = stores.claude_repo / f"{process.session_id}.jsonl"
    _claude_lines(path, _USER, _DONE)
    assert view(process)["worker_status"] is not None
    path.unlink()
    assert _assert_parity(process)["worker_status"] is None


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_claude_stopped_without_transcript_then_recovered(worker_session_stores):
    stores = worker_session_stores
    process = _proc(WorkerType.CLAUDE_CODE, status="stopped", session_id=str(uuid.uuid4()))
    assert view(process)["worker_status"] is None
    _claude_lines(stores.claude_repo / f"{process.session_id}.jsonl", _USER, _THINKING)
    process.status = "running"  # recovery
    assert _assert_parity(process)["worker_status"] is not None


# ── Codex ─────────────────────────────────────────────────────────────────────


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_codex_tee_is_superseded_by_its_rollout(worker_session_stores):
    stores = worker_session_stores
    process = _proc(WorkerType.CODEX, session_id=str(uuid.uuid4()))
    tee = codex_transcript_path_for_process(process.id)
    tee.write_text(json.dumps({"type": "thread.started", "thread_id": process.session_id}) + "\n", encoding="utf-8")
    view(process)
    assert process.driver.transcript_path(process) == tee
    rollout = _write_rollout(stores.settings.codex_sessions_dir, thread_id=process.session_id, cwd="/repo")
    _assert_parity(process)
    assert process.transcript_path == rollout, "the rollout must replace the tee once it exists"


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_codex_relaunch_resolves_the_new_rollout(worker_session_stores):
    stores = worker_session_stores
    context = {"_worker_started_at": "2026-09-16T10:00:00+00:00"}
    process = _proc(WorkerType.CODEX, context_data=dict(context))
    first = _write_rollout(
        stores.settings.codex_sessions_dir,
        thread_id=str(uuid.uuid4()),
        cwd="/repo",
        timestamp="2026-09-16T10:00:05.000Z",
    )
    view(process)
    assert process.transcript_path == first
    second = _write_rollout(
        stores.settings.codex_sessions_dir,
        thread_id=str(uuid.uuid4()),
        cwd="/repo",
        timestamp="2026-09-16T11:00:05.000Z",
    )
    process._record_worker_started_at("2026-09-16T11:00:00+00:00")
    _assert_parity(process)
    assert process.transcript_path == second


# ── Copilot ───────────────────────────────────────────────────────────────────


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_copilot_tee_and_session_record_flip(worker_session_stores):
    stores = worker_session_stores
    process = _proc(WorkerType.COPILOT, session_id=str(uuid.uuid4()))
    record = stores.settings.copilot_session_state_dir / process.session_id / "events.jsonl"
    write_copilot_events(record, process.session_id)
    tee = copilot_transcript_path_for_process(process.id)
    write_copilot_events(tee, process.session_id)
    with tee.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "user.message", "data": {"content": "second"}}) + "\n")
    view(process)
    assert process.transcript_path == tee, "the tee covering more turns wins"
    with record.open("a", encoding="utf-8") as fh:
        for n in range(3):
            fh.write(json.dumps({"type": "user.message", "data": {"content": f"pty {n}"}}) + "\n")
    _assert_parity(process)
    assert process.transcript_path == record, "a longer session record wins back"


# ── OpenCode ──────────────────────────────────────────────────────────────────


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_opencode_projection_is_rebuilt_after_a_new_turn(worker_session_stores):
    stores = worker_session_stores
    sid = f"ses_{uuid.uuid4().hex}"
    _add_turn(stores.opencode_db, sid, 1)
    process = _proc(WorkerType.OPENCODE, session_id=sid)
    view(process)
    projection = process.transcript_path
    lines_before = projection.read_text(encoding="utf-8").count("\n")
    _add_turn(stores.opencode_db, sid, 2)

    def rebuilt_by_the_warm_serialization():
        assert projection.read_text(encoding="utf-8").count("\n") > lines_before, (
            "resolving an OpenCode transcript is what rebuilds its projection; a cached resolve left it stale"
        )

    _assert_parity(process, after_warm=rebuilt_by_the_warm_serialization)
