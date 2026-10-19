"""The PTY-turn freshness contract for opencode's SQLite-backed transcript.

Three defects lived here, and each one alone was enough to hang a visible-PTY
turn until its inactivity boundary (the user message never landed, so the turn
fell through to blind delivery and then reported ``user-turn-not-landed``):

1. ``assemble_session_jsonl`` keyed its projection cache on the database's own
   mtime. OpenCode runs SQLite in WAL with ``wal_autocheckpoint=1000``, so a
   whole session's writes land in ``opencode.db-wal`` and the database file is
   never touched — the first projection was treated as fresh forever.
2. The descriptor did not declare itself DERIVED, so the poll loop resolved it
   once and then only watched the projection's own mtime — which moves solely
   when FlowPad rewrites the file.
3. ``_session_descriptor`` trusted ``process.session_id``. Opening a process
   stamps a FlowPad uuid before any worker runs and opencode mints its own
   ``ses_…``, so the recorded id resolves to nothing and the fallback (which
   only fired for an EMPTY id) never ran.
"""

from __future__ import annotations

import os
import sqlite3
import types

import pytest

from flow_sdk.transcript_analyzer.resolver import (
    sqlite_source_mtime,
    transcript_change_signature,
)


def _make_store(path):
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE session (id text PRIMARY KEY, directory text, title text, "
        "time_created integer)"
    )
    con.execute("CREATE TABLE message (id text PRIMARY KEY, session_id text, data text)")
    con.execute(
        "CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, "
        "data text, time_created integer)"
    )
    con.commit()
    con.close()


def _add_turn(path, session_id, n):
    con = sqlite3.connect(path)
    con.execute(
        "INSERT OR IGNORE INTO session VALUES (?,?,?,?)",
        (session_id, "/Users/tester/proj-a", "t", 1_700_000_000_000),
    )
    con.execute(
        "INSERT INTO message VALUES (?,?,?)",
        (f"{session_id}-m{n}", session_id, '{"role":"user"}'),
    )
    con.execute(
        "INSERT INTO part VALUES (?,?,?,?,?)",
        (
            f"{session_id}-p{n}",
            f"{session_id}-m{n}",
            session_id,
            '{"type":"text","text":"hello %d"}' % n,
            1_700_000_000_000 + n,
        ),
    )
    con.commit()
    con.close()


def _set_session_created(path, session_id, ms):
    con = sqlite3.connect(path)
    con.execute("UPDATE session SET time_created = ? WHERE id = ?", (ms, session_id))
    con.commit()
    con.close()


@pytest.fixture
def db(tmp_path, monkeypatch):
    path = tmp_path / "opencode.db"
    _make_store(path)
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history.opencode_db_path",
        lambda: path,
        raising=False,
    )
    return path


# ── the sidecar-aware primitives ────────────────────────────────────────────


def test_source_mtime_follows_the_wal_not_the_database(tmp_path):
    db = tmp_path / "s.db"
    db.write_bytes(b"x")
    os.utime(db, (1_000, 1_000))
    assert sqlite_source_mtime(db) == pytest.approx(1_000)

    # A live write goes to the WAL; the database file is untouched.
    (tmp_path / "s.db-wal").write_bytes(b"y")
    os.utime(tmp_path / "s.db-wal", (2_000, 2_000))
    assert sqlite_source_mtime(db) == pytest.approx(2_000)
    assert db.stat().st_mtime == pytest.approx(1_000)


def test_source_mtime_is_none_when_the_database_is_gone(tmp_path):
    assert sqlite_source_mtime(tmp_path / "missing.db") is None


def test_change_signature_moves_when_only_the_wal_moves(tmp_path):
    db = tmp_path / "s.db"
    db.write_bytes(b"x")
    before = transcript_change_signature(db)
    (tmp_path / "s.db-wal").write_bytes(b"yy")
    assert transcript_change_signature(db) != before


def test_change_signature_is_plain_stat_for_a_jsonl_transcript(tmp_path):
    jsonl = tmp_path / "t.jsonl"
    jsonl.write_text("{}\n")
    st = jsonl.stat()
    assert transcript_change_signature(jsonl) == (st.st_size, st.st_mtime_ns)


def test_change_signature_is_none_for_a_missing_path(tmp_path):
    assert transcript_change_signature(tmp_path / "gone.jsonl") is None


# ── the projection cache ────────────────────────────────────────────────────


def test_projection_refreshes_after_a_wal_only_write(db, tmp_path, monkeypatch):
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import session_history

    monkeypatch.setattr(
        session_history,
        "opencode_session_projection_path",
        lambda pid, sid: tmp_path / f"proj-{sid}.jsonl",
        raising=False,
    )
    _add_turn(db, "ses_x", 1)
    first = session_history.assemble_session_jsonl("ses_x", "p1")
    assert first is not None
    assert len(first.read_text().splitlines()) == 1

    # Second turn: pin the DATABASE's mtime to where it was and let only the
    # WAL move, which is exactly what SQLite does between checkpoints.
    db_mtime = db.stat().st_mtime
    _add_turn(db, "ses_x", 2)
    os.utime(db, (db_mtime, db_mtime))
    wal = db.with_name(db.name + "-wal")
    wal.write_bytes(b"dirty")
    os.utime(wal, (db_mtime + 10, db_mtime + 10))

    second = session_history.assemble_session_jsonl("ses_x", "p1")
    assert second is not None
    assert len(second.read_text().splitlines()) == 2, "projection cache never invalidated"


# ── the descriptor ──────────────────────────────────────────────────────────


# The store records session creation in epoch-ms; the fallback is bounded by the
# worker's own launch instant, so these two must straddle the fixture's sessions.
_BEFORE_MS = 1_600_000_000_000
_AFTER_MS = 1_900_000_000_000


def _iso(ms):
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def _process(session_id, started_ms=_BEFORE_MS):
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        AgenticProcessContextKey,
    )

    context = (
        {AgenticProcessContextKey.WORKER_STARTED_AT.value: _iso(started_ms)}
        if started_ms is not None
        else {}
    )
    return types.SimpleNamespace(
        id="proc-1",
        session_id=session_id,
        workdir="/Users/tester/proj-a",
        context_data=context,
    )


def test_descriptor_falls_back_when_the_recorded_id_is_a_flowpad_uuid(db, tmp_path, monkeypatch):
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import driver as drv
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import session_history

    monkeypatch.setattr(
        session_history,
        "opencode_session_projection_path",
        lambda pid, sid: tmp_path / f"proj-{sid}.jsonl",
        raising=False,
    )
    _add_turn(db, "ses_real", 1)

    process = _process("2f1c9a4e-0000-4000-8000-000000000001")
    descriptor = drv.OpenCodeDriver()._session_descriptor(process)

    assert descriptor is not None, "a FlowPad uuid must not dead-end transcript resolution"
    assert descriptor.session_id == "ses_real"
    # The poller must know to come back through the driver every tick.
    assert descriptor.derived is True


def test_descriptor_is_none_when_the_store_has_nothing_for_this_cwd(db, tmp_path, monkeypatch):
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import driver as drv
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import session_history

    monkeypatch.setattr(
        session_history,
        "opencode_session_projection_path",
        lambda pid, sid: tmp_path / f"proj-{sid}.jsonl",
        raising=False,
    )
    assert drv.OpenCodeDriver()._session_descriptor(_process("")) is None


def test_descriptor_will_not_adopt_a_session_older_than_this_worker(db, tmp_path, monkeypatch):
    """A fresh process must not replay the PREVIOUS run's conversation.

    A directory accumulates opencode sessions across runs. An unbounded "newest
    for this cwd" made a just-launched process inherit the last one — its pane
    opened showing somebody else's history, and (because those frames carry the
    store's epoch-ms stamps) it took the terminal down with an invalid date.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import driver as drv
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import session_history

    monkeypatch.setattr(
        session_history,
        "opencode_session_projection_path",
        lambda pid, sid: tmp_path / f"proj-{sid}.jsonl",
        raising=False,
    )
    _add_turn(db, "ses_old", 1)
    _set_session_created(db, "ses_old", _BEFORE_MS)

    driver = drv.OpenCodeDriver()
    # Worker launched AFTER that session was created → it is not ours.
    fresh = _process("2f1c9a4e-0000-4000-8000-000000000001", started_ms=_AFTER_MS)
    assert driver._session_descriptor(fresh) is None

    # A session created after this worker started IS ours.
    _add_turn(db, "ses_mine", 2)
    _set_session_created(db, "ses_mine", _AFTER_MS + 1000)
    descriptor = driver._session_descriptor(fresh)
    assert descriptor is not None
    assert descriptor.session_id == "ses_mine"


def test_descriptor_is_none_when_no_worker_ever_started(db, tmp_path, monkeypatch):
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import driver as drv
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import session_history

    monkeypatch.setattr(
        session_history,
        "opencode_session_projection_path",
        lambda pid, sid: tmp_path / f"proj-{sid}.jsonl",
        raising=False,
    )
    _add_turn(db, "ses_any", 1)
    _set_session_created(db, "ses_any", _BEFORE_MS)
    never_started = _process("2f1c9a4e-0000-4000-8000-000000000001", started_ms=None)
    assert drv.OpenCodeDriver()._session_descriptor(never_started) is None
