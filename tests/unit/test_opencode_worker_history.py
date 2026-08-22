"""OpenCode worker-history collector.

Unlike the other three vendors there is no per-session file to glob: opencode
keeps sessions in SQLite, so the collector is one ordered query. The fixture
below builds the minimal schema the query touches.
"""

from __future__ import annotations

import asyncio
import sqlite3

import pytest

from flow_sdk.builtin.worker_history import (
    WORKER_HISTORY_PROVIDERS,
    WorkerType,
    get_opencode_worker_history,
)


def _make_store(path, sessions):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE session (id text PRIMARY KEY, directory text, title text)")
    con.execute(
        "CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer)"
    )
    for sid, directory, title, msg_times in sessions:
        con.execute("INSERT INTO session VALUES (?,?,?)", (sid, directory, title))
        for i, t in enumerate(msg_times):
            con.execute("INSERT INTO message VALUES (?,?,?)", (f"{sid}-msg{i}", sid, t))
    con.commit()
    con.close()


@pytest.fixture
def store(tmp_path, monkeypatch):
    db = tmp_path / "opencode.db"
    _make_store(
        db,
        [
            # NOT under tmp_path: the collector drops scratch/temp cwds, so a
            # tmp_path project would be filtered out and prove nothing.
            ("ses_aaa", "/Users/tester/proj-a", "First session", [1_700_000_000_000, 1_700_000_100_000]),
            ("ses_bbb", "/Users/tester/proj-b", "Second session", [1_700_000_200_000]),
        ],
    )
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history.opencode_db_path",
        lambda: db,
    )
    return db


def test_registered_as_a_provider():
    assert WORKER_HISTORY_PROVIDERS[WorkerType.OPENCODE] is get_opencode_worker_history


def test_returns_sessions_with_cwd_and_counts(store):
    rows = asyncio.run(get_opencode_worker_history(10))
    by_id = {r.worker_id: r for r in rows}
    assert set(by_id) == {"ses_aaa", "ses_bbb"}
    assert by_id["ses_aaa"].message_count == 2
    assert by_id["ses_bbb"].message_count == 1
    assert by_id["ses_aaa"].project_cwd.endswith("proj-a")
    assert all(r.worker_type == WorkerType.OPENCODE for r in rows)


def test_last_active_comes_from_the_newest_message(store):
    rows = asyncio.run(get_opencode_worker_history(10))
    by_id = {r.worker_id: r for r in rows}
    # opencode stores unix MILLIseconds; a naive seconds read would land in 1970.
    assert by_id["ses_aaa"].last_active_time.year >= 2023


def test_limit_is_honoured(store):
    assert len(asyncio.run(get_opencode_worker_history(1))) == 1


def test_missing_store_is_empty_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history.opencode_db_path",
        lambda: tmp_path / "absent.db",
    )
    assert asyncio.run(get_opencode_worker_history(5)) == []


def test_unreadable_store_is_empty_not_an_error(tmp_path, monkeypatch):
    """A database that exists but isn't one must not take the history panel down."""
    junk = tmp_path / "opencode.db"
    junk.write_text("not a database", encoding="utf-8")
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history.opencode_db_path",
        lambda: junk,
    )
    assert asyncio.run(get_opencode_worker_history(5)) == []
