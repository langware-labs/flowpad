from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.fs_records import worker_history as wh
from flow_sdk.fs_records.worker_history import WorkerHistoryEntry, WorkerType


def _entry(worker_type: WorkerType, worker_id: str, timestamp: str) -> WorkerHistoryEntry:
    return WorkerHistoryEntry(
        worker_type=worker_type,
        worker_id=worker_id,
        last_active_time=datetime.fromisoformat(timestamp).replace(tzinfo=timezone.utc),
    )


async def _noop_processes():
    return []


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_get_worker_history_merges_sorts_and_limits(monkeypatch):
    claude_mid = _entry(WorkerType.CLAUDE, "claude-mid", "2026-05-06T10:00:00")
    claude_old = _entry(WorkerType.CLAUDE, "claude-old", "2026-05-06T08:00:00")
    codex_new = _entry(WorkerType.CODEX, "codex-new", "2026-05-06T12:00:00")

    async def _claude(_limit, _idx):
        return [claude_old, claude_mid]

    async def _codex(_limit, _idx):
        return [codex_new]

    monkeypatch.setattr(
        wh,
        "WORKER_HISTORY_PROVIDERS",
        {
            WorkerType.CLAUDE: _claude,
            WorkerType.CODEX: _codex,
        },
    )
    monkeypatch.setattr(wh, "_load_agentic_processes", _noop_processes)
    monkeypatch.setattr(wh, "_agentic_process_only_entries", lambda procs, seen: [])

    result = await wh.get_worker_history(limit=2)

    assert [(e.worker_type, e.worker_id) for e in result] == [
        (WorkerType.CODEX, "codex-new"),
        (WorkerType.CLAUDE, "claude-mid"),
    ]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_get_worker_history_dedupes_by_worker_type_and_id(monkeypatch):
    duplicate_new = _entry(WorkerType.CODEX, "same-session", "2026-05-06T12:00:00")
    duplicate_old = _entry(WorkerType.CODEX, "same-session", "2026-05-06T09:00:00")
    claude_same_id = _entry(WorkerType.CLAUDE, "same-session", "2026-05-06T11:00:00")

    async def _claude(_limit, _idx):
        return [claude_same_id]

    async def _codex(_limit, _idx):
        return [duplicate_new, duplicate_old]

    monkeypatch.setattr(
        wh,
        "WORKER_HISTORY_PROVIDERS",
        {
            WorkerType.CODEX: _codex,
            WorkerType.CLAUDE: _claude,
        },
    )
    monkeypatch.setattr(wh, "_load_agentic_processes", _noop_processes)
    monkeypatch.setattr(wh, "_agentic_process_only_entries", lambda procs, seen: [])

    result = await wh.get_worker_history(limit=10)

    assert [(e.worker_type, e.worker_id) for e in result] == [
        (WorkerType.CODEX, "same-session"),
        (WorkerType.CLAUDE, "same-session"),
    ]


# ---------------------------------------------------------------------------
# Scratch-session filter — keeps the picker from drowning in pytest tmpdirs.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "encoded,expected",
    [
        ("-private-var-folders-t7-fixturedir", True),
        ("-var-folders-abc", True),
        ("-tmp-something", True),
        ("-history-merge-test-deadbeef", True),
        ("-Users-shlom-Documents-dev-flowpad-oss", False),
        ("-Users-shlom-projects-real-app", False),
    ],
)
def test_is_scratch_encoded_dir(encoded, expected):
    assert wh._is_scratch_encoded_dir(encoded) is expected


@pytest.mark.parametrize(
    "cwd,expected",
    [
        ("/private/var/folders/t7/foo", True),
        ("/var/folders/t7/foo", True),
        ("/tmp/something", True),
        (None, False),
        ("", False),
        ("/Users/shlom/Documents/dev/flowpad-oss", False),
    ],
)
def test_is_scratch_cwd(cwd, expected):
    assert wh._is_scratch_cwd(cwd) is expected


def test_collect_claude_skips_scratch_encoded_dirs(monkeypatch, tmp_path):
    """jsonl files under scratch-prefixed encoded dirs must not enter the slice."""
    projects_dir = tmp_path / "projects"
    projects_dir.mkdir()

    real_dir = projects_dir / "-Users-shlom-Documents-dev-flowpad-oss"
    real_dir.mkdir()
    real_jsonl = real_dir / "real-session.jsonl"
    real_jsonl.write_text('{"sessionId":"real-session","cwd":"/Users/shlom/Documents/dev/flowpad-oss"}\n')

    scratch_dir = projects_dir / "-private-var-folders-t7-foo"
    scratch_dir.mkdir()
    scratch_jsonl = scratch_dir / "scratch-session.jsonl"
    scratch_jsonl.write_text('{"sessionId":"scratch-session","cwd":"/private/var/folders/t7/foo"}\n')
    # Make the scratch file *newer* so without the filter it would dominate.
    import os as _os, time as _time
    now = _time.time()
    _os.utime(real_jsonl, (now - 60, now - 60))
    _os.utime(scratch_jsonl, (now, now))

    import flow_sdk.instance_settings as _is_mod
    monkeypatch.setattr(
        _is_mod, "get_instance_settings",
        lambda: SimpleNamespace(claude_projects_dir=projects_dir),
    )
    # Avoid loading the real history file.
    monkeypatch.setattr(wh, "_build_history_latest_prompt_index", lambda: {})

    # Stub ClaudeSessionRecord to a tiny shape that returns what the loop reads.
    class _StubSession:
        def __init__(self, sid, cwd):
            self.session_id = sid
            self._cwd = cwd
            self.slug = None
            self.git_branch = None
            self.message_count = 0
            self.last_user_message = None

        def __getattribute__(self, name):
            if name == "__dict__":
                return {"cwd": object.__getattribute__(self, "_cwd"), "project_encoded_name": None, "custom_title": None}
            return object.__getattribute__(self, name)

        @classmethod
        def from_jsonl(cls, path: Path):
            import json as _json
            raw = _json.loads(path.read_text().splitlines()[0])
            return cls(raw["sessionId"], raw.get("cwd"))

    import flow_sdk.fs_records.claude.claude_session as cs
    monkeypatch.setattr(cs, "ClaudeSessionRecord", _StubSession)

    rows = wh._collect_claude_entries_sync(limit=10, process_index={})
    ids = {r.worker_id for r in rows}
    assert "real-session" in ids
    assert "scratch-session" not in ids


def test_agentic_process_only_entries_skips_scratch_workdir():
    """AP entities created from tmpdir fixtures must not surface in worker history."""
    scratch_proc = SimpleNamespace(
        id="proc-1",
        session_id="sid-scratch",
        workdir="/private/var/folders/t7/fixture-XXX",
        project_id=None,
        project_encoded_name=None,
        name=None,
        worker_type=None,
        updated_date=datetime(2026, 5, 23, 14, 0, tzinfo=timezone.utc),
    )
    real_proc = SimpleNamespace(
        id="proc-2",
        session_id="sid-real",
        workdir="/Users/shlom/Documents/dev/flowpad-oss",
        project_id="proj-real",
        project_encoded_name=None,
        name="real work",
        worker_type=None,
        updated_date=datetime(2026, 5, 23, 13, 0, tzinfo=timezone.utc),
    )
    bare_proc = SimpleNamespace(
        id="proc-3",
        session_id="sid-bare",
        workdir=None,
        project_id=None,  # no anchor at all → also filtered
        project_encoded_name=None,
        name=None,
        worker_type=None,
        updated_date=datetime(2026, 5, 23, 12, 0, tzinfo=timezone.utc),
    )

    entries = wh._agentic_process_only_entries(
        [scratch_proc, real_proc, bare_proc], seen=set()
    )
    ids = {e.worker_id for e in entries}
    assert ids == {"sid-real"}
