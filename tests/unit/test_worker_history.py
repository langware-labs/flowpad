from __future__ import annotations

from datetime import datetime, timezone

from flow_sdk.fs_records import worker_history as wh
from flow_sdk.fs_records.worker_history import WorkerHistoryEntry, WorkerType


def _entry(worker_type: WorkerType, worker_id: str, timestamp: str) -> WorkerHistoryEntry:
    return WorkerHistoryEntry(
        worker_type=worker_type,
        worker_id=worker_id,
        last_active_time=datetime.fromisoformat(timestamp).replace(tzinfo=timezone.utc),
    )


def test_get_worker_history_merges_sorts_and_limits(monkeypatch):
    claude_mid = _entry(WorkerType.CLAUDE, "claude-mid", "2026-05-06T10:00:00")
    claude_old = _entry(WorkerType.CLAUDE, "claude-old", "2026-05-06T08:00:00")
    codex_new = _entry(WorkerType.CODEX, "codex-new", "2026-05-06T12:00:00")

    monkeypatch.setattr(
        wh,
        "WORKER_HISTORY_PROVIDERS",
        {
            WorkerType.CLAUDE: lambda limit: [claude_old, claude_mid],
            WorkerType.CODEX: lambda limit: [codex_new],
        },
    )
    monkeypatch.setattr(wh, "_agentic_process_only_entries", lambda seen: [])

    result = wh.get_worker_history(limit=2)

    assert [(e.worker_type, e.worker_id) for e in result] == [
        (WorkerType.CODEX, "codex-new"),
        (WorkerType.CLAUDE, "claude-mid"),
    ]


def test_get_worker_history_dedupes_by_worker_type_and_id(monkeypatch):
    duplicate_new = _entry(WorkerType.CODEX, "same-session", "2026-05-06T12:00:00")
    duplicate_old = _entry(WorkerType.CODEX, "same-session", "2026-05-06T09:00:00")
    claude_same_id = _entry(WorkerType.CLAUDE, "same-session", "2026-05-06T11:00:00")

    monkeypatch.setattr(
        wh,
        "WORKER_HISTORY_PROVIDERS",
        {
            WorkerType.CODEX: lambda limit: [duplicate_new, duplicate_old],
            WorkerType.CLAUDE: lambda limit: [claude_same_id],
        },
    )
    monkeypatch.setattr(wh, "_agentic_process_only_entries", lambda seen: [])

    result = wh.get_worker_history(limit=10)

    assert [(e.worker_type, e.worker_id) for e in result] == [
        (WorkerType.CODEX, "same-session"),
        (WorkerType.CLAUDE, "same-session"),
    ]
