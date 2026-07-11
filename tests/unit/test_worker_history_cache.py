"""Worker-history derived-stats cache — mechanism + collector equivalence.

Covers the ``WorkerSessionStatsCache`` basics (validators, self-heal, prune)
and the load-bearing collector guarantees: a warm cache yields byte-identical
entries with ZERO transcript parses, an append re-parses exactly the changed
file, and a broken cache degrades to the uncached path instead of failing.
Spies wrap the REAL extract/stats functions (no mocks of the code under test).
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

import flow_sdk.instance_settings as _is_mod
from flow_sdk.builtin import worker_history as wh
from flow_sdk.builtin.worker_history_cache import SCHEMA_VERSION, WorkerSessionStatsCache

from .conftest import write_claude_transcript

_SIDS = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
]


# ── cache-class basics ────────────────────────────────────────────────────────


def _key(path: Path) -> tuple[str, int, int]:
    st = path.stat()
    return (str(path), st.st_mtime_ns, st.st_size)


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_get_many_on_missing_db_is_all_miss_and_does_not_create(tmp_path):
    db = tmp_path / "cache.sqlite"
    cache = WorkerSessionStatsCache(db)
    assert cache.get_many([("/nope.jsonl", 1, 2)]) == {}
    assert not db.exists()


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_put_then_get_roundtrips_payload(tmp_path):
    db = tmp_path / "cache.sqlite"
    f = tmp_path / "a.jsonl"
    f.write_text("{}\n")
    cache = WorkerSessionStatsCache(db)
    payload = {"session_id": "s1", "last_content_ts": "2026-06-21T10:32:44+00:00", "n": 3}
    cache.put_many([(*_key(f), "claude", payload)])
    assert cache.get_many([_key(f)]) == {str(f): payload}


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_changed_mtime_or_size_misses(tmp_path):
    db = tmp_path / "cache.sqlite"
    f = tmp_path / "a.jsonl"
    f.write_text("{}\n")
    path, mtime_ns, size = _key(f)
    cache = WorkerSessionStatsCache(db)
    cache.put_many([(path, mtime_ns, size, "claude", {"session_id": "s1"})])
    assert cache.get_many([(path, mtime_ns + 1, size)]) == {}
    assert cache.get_many([(path, mtime_ns, size + 1)]) == {}
    assert cache.get_many([(path, mtime_ns, size)]) != {}


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_corrupt_db_self_heals(tmp_path):
    db = tmp_path / "cache.sqlite"
    f = tmp_path / "a.jsonl"
    f.write_text("{}\n")
    db.write_bytes(b"this is not a sqlite file, definitely garbage bytes")
    cache = WorkerSessionStatsCache(db)
    assert cache.get_many([_key(f)]) == {}
    cache.put_many([(*_key(f), "claude", {"session_id": "s1"})])
    assert cache.get_many([_key(f)]) == {str(f): {"session_id": "s1"}}


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_schema_version_mismatch_rebuilds(tmp_path):
    db = tmp_path / "cache.sqlite"
    f = tmp_path / "a.jsonl"
    f.write_text("{}\n")
    cache = WorkerSessionStatsCache(db)
    cache.put_many([(*_key(f), "claude", {"session_id": "old"})])
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA user_version = 99")
    assert cache.get_many([_key(f)]) == {}  # mismatched schema reads as all-miss
    cache.put_many([(*_key(f), "claude", {"session_id": "new"})])
    assert cache.get_many([_key(f)]) == {str(f): {"session_id": "new"}}
    with sqlite3.connect(db) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_prune_drops_rows_past_horizon_on_next_write(tmp_path):
    db = tmp_path / "cache.sqlite"
    old_f, new_f = tmp_path / "old.jsonl", tmp_path / "new.jsonl"
    old_f.write_text("{}\n")
    new_f.write_text("{}\n")
    cache = WorkerSessionStatsCache(db)
    cache.put_many([(*_key(old_f), "claude", {"session_id": "old"})])
    stale = int(time.time()) - 31 * 24 * 3600
    with sqlite3.connect(db) as conn:
        conn.execute("UPDATE session_stats SET updated_at = ?", (stale,))
    cache.put_many([(*_key(new_f), "claude", {"session_id": "new"})])
    assert cache.get_many([_key(old_f)]) == {}
    assert cache.get_many([_key(new_f)]) != {}


# ── collector integration ─────────────────────────────────────────────────────


@pytest.fixture
def wh_env(tmp_path, monkeypatch):
    """Isolated projects dir + cache path; prompt index stubbed to empty."""
    projects = tmp_path / "projects"
    projects.mkdir()
    proj = projects / "-repo"
    proj.mkdir()
    ns = SimpleNamespace(
        claude_projects_dir=projects,
        codex_sessions_dir=tmp_path / "codex-sessions",
        worker_history_cache_path=tmp_path / "wh_cache.sqlite",
    )
    monkeypatch.setattr(_is_mod, "get_instance_settings", lambda: ns)
    monkeypatch.setattr(wh, "_build_history_latest_prompt_index", lambda: {})
    return SimpleNamespace(settings=ns, proj=proj)


def _spy(monkeypatch, module, name) -> list:
    calls: list = []
    real = getattr(module, name)

    def wrapper(*args, **kwargs):
        calls.append(args)
        return real(*args, **kwargs)

    monkeypatch.setattr(module, name, wrapper)
    return calls


def _dump(entries) -> list[dict]:
    return [e.model_dump(mode="json") for e in entries]


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_claude_warm_run_parses_nothing_and_matches_cold(wh_env, monkeypatch):
    from flow_sdk.fs_store.indexer.functions import claude_sessions as cs

    for sid in _SIDS:
        write_claude_transcript(wh_env.proj, sid, n_lines=3)
    extract_calls = _spy(monkeypatch, cs, "extract_claude_session_from_path")
    stats_calls = _spy(monkeypatch, cs, "ensure_claude_session_stats")

    cold = wh._collect_claude_entries_sync(10, {})
    assert len(cold) == len(_SIDS)
    assert len(extract_calls) == len(_SIDS)

    extract_calls.clear()
    stats_calls.clear()
    warm = wh._collect_claude_entries_sync(10, {})
    assert extract_calls == [] and stats_calls == [], "warm run must not touch transcripts"
    assert _dump(warm) == _dump(cold), "cached entries must be identical to parsed ones"


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_claude_append_reparses_only_the_changed_file(wh_env, monkeypatch):
    from flow_sdk.fs_store.indexer.functions import claude_sessions as cs

    paths = {sid: write_claude_transcript(wh_env.proj, sid, n_lines=2) for sid in _SIDS}
    wh._collect_claude_entries_sync(10, {})  # warm the cache

    changed_sid = _SIDS[1]
    with open(paths[changed_sid], "a", encoding="utf-8") as fh:
        fh.write(
            json.dumps({
                "type": "user",
                "message": {"role": "user", "content": "the newest prompt"},
                "timestamp": "2026-04-27T09:00:00.000Z",
                "cwd": "/repo",
                "sessionId": changed_sid,
                "version": "2.1.119",
                "gitBranch": "main",
            })
            + "\n"
        )

    extract_calls = _spy(monkeypatch, cs, "extract_claude_session_from_path")
    rows = wh._collect_claude_entries_sync(10, {})
    assert [a[0] for a in extract_calls] == [paths[changed_sid]], (
        "exactly the appended file must re-parse"
    )
    changed = next(r for r in rows if r.worker_id == changed_sid)
    assert changed.message_count == 3
    assert "the newest prompt" in (changed.last_prompt or "")


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_claude_unusable_cache_path_falls_back_to_parsing(wh_env, monkeypatch):
    # A directory at the cache path breaks both open modes.
    wh_env.settings.worker_history_cache_path.mkdir()
    for sid in _SIDS:
        write_claude_transcript(wh_env.proj, sid)
    rows1 = wh._collect_claude_entries_sync(10, {})
    rows2 = wh._collect_claude_entries_sync(10, {})
    assert len(rows1) == len(_SIDS)
    assert _dump(rows2) == _dump(rows1)


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_codex_warm_run_parses_nothing_and_matches_cold(wh_env, monkeypatch):
    from flow_sdk.fs_store.indexer.functions import codex_sessions as cx

    rollout_src = (
        Path(__file__).parent / "resources" / "transcripts" / "codex_rollout.jsonl"
    ).read_text()
    day = wh_env.settings.codex_sessions_dir / "2026" / "03" / "11"
    day.mkdir(parents=True)
    (day / "rollout-2026-03-11T17-02-01-019cdd6b-49a7-7480-9da1-aaaaaaaaaaaa.jsonl").write_text(
        rollout_src
    )
    (day / "rollout-2026-03-11T17-30-00-019cdd99-49a7-7480-9da1-bbbbbbbbbbbb.jsonl").write_text(
        rollout_src.replace('"cwd": "/repo"', '"cwd": "/Users/test/proj_b"', 1).replace(
            "019cdd6b-49a7-7480-9da1-aaaaaaaaaaaa", "019cdd99-49a7-7480-9da1-bbbbbbbbbbbb"
        )
    )

    extract_calls = _spy(monkeypatch, cx, "extract_codex_session_from_path")
    cold = wh._collect_codex_entries_sync(10, {})
    assert len(cold) == 2
    assert len(extract_calls) == 2

    extract_calls.clear()
    warm = wh._collect_codex_entries_sync(10, {})
    assert extract_calls == [], "warm codex run must not touch rollouts"
    assert _dump(warm) == _dump(cold)


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_copilot_warm_run_parses_nothing_and_matches_cold(wh_env, monkeypatch, tmp_path):
    from flow_sdk.builtin.agentic_process.cli_drivers.copilot import session_history as sh

    root = tmp_path / "copilot-state"
    for i, sid in enumerate(("cop-a", "cop-b")):
        d = root / sid
        d.mkdir(parents=True)
        (d / "events.jsonl").write_text(
            json.dumps({"type": "session.start", "data": {"id": sid, "cwd": f"/repo{i}"}})
            + "\n"
            + json.dumps({
                "type": "user.message",
                "timestamp": "2026-04-26T13:12:32.389Z",
                "data": {"content": f"copilot prompt {i}"},
            })
            + "\n"
        )
    monkeypatch.setattr(sh, "copilot_session_state_root", lambda: root)

    meta_calls = _spy(monkeypatch, sh, "read_copilot_session_meta")
    stats_calls = _spy(monkeypatch, wh, "_copilot_stats")

    cold = wh._collect_copilot_entries_sync(10, {})
    assert len(cold) == 2
    assert len(meta_calls) == 2 and len(stats_calls) == 2

    meta_calls.clear()
    stats_calls.clear()
    warm = wh._collect_copilot_entries_sync(10, {})
    assert meta_calls == [] and stats_calls == [], "warm copilot run must not read files"
    assert _dump(warm) == _dump(cold)


# ── provider concurrency tolerance ────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_one_failing_provider_does_not_drop_the_others(monkeypatch):
    from datetime import datetime, timezone

    ok_entry = wh.WorkerHistoryEntry(
        worker_type=wh.WorkerType.CLAUDE,
        worker_id="ok-1",
        last_active_time=datetime(2026, 5, 6, tzinfo=timezone.utc),
    )

    async def _ok(_limit, _idx, _pids=None, _cwd_map=None):
        return [ok_entry]

    async def _boom(_limit, _idx, _pids=None, _cwd_map=None):
        raise RuntimeError("provider exploded")

    async def _not_impl(_limit, _idx, _pids=None, _cwd_map=None):
        raise NotImplementedError

    async def _noop_processes():
        return []

    monkeypatch.setattr(
        wh,
        "WORKER_HISTORY_PROVIDERS",
        {
            wh.WorkerType.CLAUDE: _ok,
            wh.WorkerType.CODEX: _boom,
            wh.WorkerType.COPILOT: _not_impl,
        },
    )
    monkeypatch.setattr(wh, "_load_agentic_processes", _noop_processes)
    monkeypatch.setattr(
        wh, "_agentic_process_only_entries", lambda procs, seen, pids=None, cwd_map=None: []
    )

    async def _no_cwd_map():
        return {}

    monkeypatch.setattr(wh, "_cwd_to_project_id", _no_cwd_map)

    result = await wh.get_worker_history(limit=10)
    assert [e.worker_id for e in result] == ["ok-1"]
