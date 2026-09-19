"""The cost overview loads token stats without the searchable-content parse,
and serves unchanged transcripts from its per-file stats cache."""

import json
import os
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.faas.analytics.cost_overview import get_cost_overview, load_recent_sessions_for_cost
from flow_sdk.builtin.worker_history_cache import WorkerSessionStatsCache
from flow_sdk.fs_store.indexer.functions import claude_sessions as _cs

SID = "11111111-1111-4111-8111-111111111111"


def test_recent_sessions_carry_token_stats_without_search_content(claude_projects):
    rows = [
        {"type": "user", "message": {"role": "user", "content": "Summarize the release notes"},
         "uuid": "u1", "timestamp": "2026-09-16T10:00:00Z", "cwd": "/repo", "sessionId": SID},
        {"type": "assistant", "uuid": "a1", "parentUuid": "u1", "timestamp": "2026-09-16T10:00:05Z",
         "cwd": "/repo", "sessionId": SID,
         "message": {"role": "assistant", "model": "claude-opus-5", "content": [{"type": "text", "text": "Done."}],
                     "usage": {"input_tokens": 1200, "output_tokens": 340,
                               "cache_read_input_tokens": 50, "cache_creation_input_tokens": 7}}},
    ]
    (claude_projects / f"{SID}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")

    session, = load_recent_sessions_for_cost(limit=10)

    assert (session["input_tokens"], session["output_tokens"]) == (1200, 340)
    assert (session["cache_read_tokens"], session["cache_creation_tokens"]) == (50, 7)
    assert session["primary_model"] == "claude-opus-5"
    assert session["content"] == ""


# ── per-file stats cache ──────────────────────────────────────────────────────

SIDS = [
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
]


def _assistant_row(sid: str, n: int) -> dict:
    return {"type": "assistant", "uuid": f"a{n}", "timestamp": f"2026-09-16T10:0{n}:05Z", "cwd": "/repo",
            "sessionId": sid,
            "message": {"role": "assistant", "model": "claude-opus-5", "content": [{"type": "text", "text": "ok"}],
                        "usage": {"input_tokens": 100 * n, "output_tokens": 10 * n,
                                  "cache_read_input_tokens": n, "cache_creation_input_tokens": n}}}


def _write_session(proj: Path, sid: str, n: int) -> Path:
    user = {"type": "user", "message": {"role": "user", "content": f"prompt {n}"}, "uuid": f"u{n}",
            "timestamp": f"2026-09-16T10:0{n}:00Z", "cwd": "/repo", "sessionId": sid}
    p = proj / f"{sid}.jsonl"
    p.write_text(json.dumps(user) + "\n" + json.dumps(_assistant_row(sid, n)) + "\n", encoding="utf-8")
    os.utime(p, ns=(n * 10**9, n * 10**9))  # distinct mtimes → deterministic order
    return p


@pytest.fixture
def cost_env(tmp_path, monkeypatch):
    """Isolated projects dir, instance settings carrying a worker-history cache path."""
    projects = tmp_path / "projects"
    proj = projects / "-repo"
    proj.mkdir(parents=True)
    settings = SimpleNamespace(claude_projects_dir=projects, worker_history_cache_path=tmp_path / "wh_cache.sqlite")
    monkeypatch.setattr(_cs, "get_instance_settings", lambda: settings)
    paths = [_write_session(proj, sid, n) for n, sid in enumerate(SIDS, start=1)]
    return SimpleNamespace(settings=settings, paths=paths, cost_db=tmp_path / "cost_stats_cache.sqlite")


def _spy(monkeypatch, module, name) -> list:
    calls: list = []
    real = getattr(module, name)

    def wrapper(*args, **kwargs):
        calls.append(args)
        return real(*args, **kwargs)

    monkeypatch.setattr(module, name, wrapper)
    return calls


def _overview(sessions: list[dict]) -> dict:
    out = get_cost_overview(sessions)
    out.pop("generated_at")
    return out


def test_warm_run_parses_nothing_and_matches_cold(cost_env, monkeypatch):
    stats_calls = _spy(monkeypatch, _cs, "ensure_claude_session_stats")

    cold = load_recent_sessions_for_cost(limit=10)
    assert len(stats_calls) == len(SIDS)
    assert [s["id"] for s in cold] == SIDS[::-1], "newest mtime first"

    stats_calls.clear()
    warm = load_recent_sessions_for_cost(limit=10)
    assert stats_calls == [], "warm run must not parse any transcript"
    assert warm == cold
    assert _overview(warm) == _overview(cold)
    assert _overview(warm)["totals"]["total_input_tokens"] == 600


def test_append_reparses_only_the_changed_file(cost_env, monkeypatch):
    from flow_sdk.assets.types import claude_sessions as claude_reader

    load_recent_sessions_for_cost(limit=10)  # warm the cache
    changed = cost_env.paths[0]
    with open(changed, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({**_assistant_row(SIDS[0], 5), "uuid": "a-extra"}) + "\n")

    extract_calls = _spy(monkeypatch, claude_reader, "extract_claude_session_from_path")
    sessions = load_recent_sessions_for_cost(limit=10)

    assert [a[0] for a in extract_calls] == [changed], "exactly the appended file must re-parse"
    by_id = {s["id"]: s for s in sessions}
    assert by_id[SIDS[0]]["input_tokens"] == 100 + 500


def test_unusable_cache_path_falls_back_to_parsing(cost_env, monkeypatch):
    cost_env.cost_db.mkdir()  # a directory where the sqlite file should be
    stats_calls = _spy(monkeypatch, _cs, "ensure_claude_session_stats")

    first = load_recent_sessions_for_cost(limit=10)
    second = load_recent_sessions_for_cost(limit=10)

    assert len(stats_calls) == 2 * len(SIDS), "no cache → every run parses"
    assert first == second
    assert _overview(first)["totals"]["total_input_tokens"] == 600


def test_worker_history_cache_is_untouched(cost_env):
    wh_db = cost_env.settings.worker_history_cache_path
    other = cost_env.paths[0].parent / "other.jsonl"
    other.write_text("{}\n")
    st = other.stat()
    WorkerSessionStatsCache(wh_db).put_many([(str(other), st.st_mtime_ns, st.st_size, "claude", {"x": 1})])
    with sqlite3.connect(wh_db) as conn:
        before = conn.execute("SELECT * FROM session_stats ORDER BY path").fetchall()

    load_recent_sessions_for_cost(limit=10)

    with sqlite3.connect(wh_db) as conn:
        assert conn.execute("SELECT * FROM session_stats ORDER BY path").fetchall() == before
    assert cost_env.cost_db.is_file()
