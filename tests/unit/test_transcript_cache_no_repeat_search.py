"""Serializing a process must not search for its transcript again.

RCA 2026-09-16 (prod slow "New Claude chat"): every ``model_dump`` runs
``fetch_worker_status`` → ``driver.transcript_path``, and every driver re-found
the file by searching — Claude walked ``~/.claude/projects``, Codex rglob'd
``~/.codex/sessions``. A 235-process list blocked the event loop for 3.4s.

Counts, never milliseconds: spies over the REAL resolvers count the searches,
and every store carries ``DECOYS`` unrelated sessions so a regression is a
search, not a lucky hit. ``process`` and ``view`` are shared with
``test_transcript_cache_parity.py`` and the live tier.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.functions.claude_sessions as _claude_sessions
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.codex import driver as _codex_driver
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import driver as _copilot_driver
from flow_sdk.builtin.agentic_process.cli_drivers.opencode import driver as _opencode_driver
from flow_sdk.flowpad_types.enums import WorkerType

from .conftest import write_claude_transcript
from .test_codex_transcript_resolution import _write_rollout
from .test_opencode_live_transcript_freshness import _add_turn
from .test_worker_history_cache import _spy

DECOYS = 300
ALL_WORKERS = [WorkerType.CLAUDE_CODE, WorkerType.CODEX, WorkerType.COPILOT, WorkerType.OPENCODE]
#: The serialized fields a transcript lookup decides.
FIELDS = ("worker_status", "worker_status_detail", "busy", "ready_for_input")

_RESOLVERS = [
    (_claude_sessions, "get_claude_session"),
    (_codex_driver, "find_codex_session_jsonl"),
    (_codex_driver, "find_latest_codex_session_jsonl"),
    (_copilot_driver, "find_copilot_session_jsonl"),
    (_copilot_driver, "find_latest_copilot_session_jsonl"),
    (_opencode_driver, "assemble_session_jsonl"),
]


def view(process: AgenticProcess) -> dict:
    data = process.model_dump(mode="json")
    return {field: data.get(field) for field in FIELDS}


def process(worker: WorkerType, status: str = "running", **kwargs) -> AgenticProcess:
    return AgenticProcess(id=str(uuid.uuid4()), worker_type=worker.value, workdir="/repo", status=status, **kwargs)


def write_copilot_events(path: Path, sid: str = "s") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    events = [
        {"type": "session.start", "data": {"sessionId": sid}},
        {"type": "user.message", "data": {"content": "hi"}},
        {"type": "assistant.message", "data": {"content": "hello"}},
        {"type": "assistant.turn_end", "data": {"turnId": "0"}},
    ]
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
    return path


@pytest.fixture
def decoys(worker_session_stores):
    """``DECOYS`` foreign sessions in every searched store."""
    stores = worker_session_stores
    for i in range(DECOYS):
        (stores.claude_repo.parent / f"-decoy-{i}").mkdir()
        _write_rollout(stores.settings.codex_sessions_dir, thread_id=str(uuid.uuid4()), cwd=f"/decoy-{i}")
        write_copilot_events(stores.settings.copilot_session_state_dir / str(uuid.uuid4()) / "events.jsonl")
    return stores


@pytest.fixture
def searches(monkeypatch) -> list[list]:
    """One call list per real resolver, spied."""
    return [_spy(monkeypatch, module, name) for module, name in _RESOLVERS]


def _with_transcript(worker: WorkerType, stores, status: str) -> AgenticProcess:
    """A process whose worker's own session store holds its transcript."""
    sid = str(uuid.uuid4())
    if worker is WorkerType.CLAUDE_CODE:
        write_claude_transcript(stores.claude_repo, sid)
    elif worker is WorkerType.CODEX:
        _write_rollout(stores.settings.codex_sessions_dir, thread_id=sid, cwd="/repo")
    elif worker is WorkerType.COPILOT:
        write_copilot_events(stores.settings.copilot_session_state_dir / sid / "events.jsonl", sid)
    else:
        sid = f"ses_{uuid.uuid4().hex}"
        _add_turn(stores.opencode_db, sid, 1)
    return process(worker, status, session_id=sid)


def _serialize_twice(processes, searches) -> tuple[int, int]:
    """Search counts for a first and a second serialization of the same processes."""
    for p in processes:
        p.model_dump(mode="json")
    first = sum(len(calls) for calls in searches)
    for calls in searches:
        calls.clear()
    for p in processes:
        p.model_dump(mode="json")
    return first, sum(len(calls) for calls in searches)


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.parametrize("worker", ALL_WORKERS, ids=lambda w: w.value)
def test_stopped_process_is_searched_at_most_once(worker, decoys, searches):
    first, second = _serialize_twice([_with_transcript(worker, decoys, "stopped")], searches)
    assert first >= 1, "the first serialization must actually resolve the transcript"
    assert second == 0, f"{worker.value}: re-serializing an unchanged stopped process searched {second} times"


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.parametrize("worker", [WorkerType.CLAUDE_CODE, WorkerType.CODEX], ids=lambda w: w.value)
def test_stopped_process_without_transcript_is_searched_at_most_once(worker, decoys, searches):
    _, second = _serialize_twice([process(worker, "stopped", session_id=str(uuid.uuid4()))], searches)
    assert second == 0, f"{worker.value}: a known-missing transcript was searched for {second} more times"


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.parametrize("worker", [WorkerType.CLAUDE_CODE, WorkerType.CODEX], ids=lambda w: w.value)
def test_running_process_with_final_transcript_is_searched_at_most_once(worker, decoys, searches):
    # Claude's session file and Codex's session-id rollout are the worker's own
    # final record: a live turn appends to them, it never moves them.
    _, second = _serialize_twice([_with_transcript(worker, decoys, "running")], searches)
    assert second == 0, f"{worker.value}: a live process with a final transcript searched {second} more times"


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_list_of_stopped_processes_is_searched_once(decoys, searches):
    processes = [
        _with_transcript(worker, decoys, "stopped")
        for _ in range(50)
        for worker in (WorkerType.CLAUDE_CODE, WorkerType.CODEX)
    ] + [process(WorkerType.CLAUDE_CODE, "stopped", session_id=str(uuid.uuid4())) for _ in range(100)]
    first, second = _serialize_twice(processes, searches)
    assert first >= len(processes)
    assert second == 0, f"re-serializing a 200-process list searched {second} times"
