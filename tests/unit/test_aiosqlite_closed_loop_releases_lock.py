"""A connection whose event loop closes mid-call must release the writer lock.

aiosqlite hands every result back through the caller's loop. When that loop
has closed (a TestClient portal torn down by pytest-timeout while a
``BEGIN IMMEDIATE`` waits out busy_timeout), upstream's worker thread dies with
``Event loop is closed`` and the sqlite handle keeps its transaction for the
rest of the process: every later writer fails with "database is locked"
(QA cycle 2026-09-23, tests/long_tests/test_restart_required_ws.py onward).
"""
from __future__ import annotations

import asyncio
import sqlite3
import threading

import aiosqlite
import pytest

import flow_sdk.db.drivers.sqlite.connection  # noqa: F401 — installs the aiosqlite patches

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _writer_lock_is_free(db: str) -> bool:
    probe = sqlite3.connect(db, timeout=0, isolation_level=None)
    try:
        probe.execute("BEGIN IMMEDIATE")
        probe.execute("ROLLBACK")
        return True
    except sqlite3.OperationalError:
        return False
    finally:
        probe.close()


def test_a_call_answered_after_its_loop_closed_releases_the_writer_lock(tmp_path):
    db = str(tmp_path / "db.sqlite")
    in_flight = threading.Event()
    finish = threading.Event()
    conn: aiosqlite.Connection | None = None

    async def open_a_write_and_leave_a_call_in_flight():
        nonlocal conn
        conn = await aiosqlite.connect(db, isolation_level=None)
        await conn.execute("BEGIN IMMEDIATE")
        await conn.create_function("hold", 0, lambda: (in_flight.set(), finish.wait())[0])
        asyncio.ensure_future(conn.execute("SELECT hold()"))
        while not in_flight.is_set():  # the worker has picked the call up
            await asyncio.sleep(0.005)

    loop = asyncio.new_event_loop()
    loop.run_until_complete(open_a_write_and_leave_a_call_in_flight())
    loop.close()  # the owner is gone while its call is still on the worker
    assert not _writer_lock_is_free(db)

    finish.set()  # the call returns into a closed loop
    conn._thread.join(timeout=5)
    assert not conn._thread.is_alive()
    assert _writer_lock_is_free(db), "the abandoned connection still holds the writer lock"

    # A later teardown, on a live loop, finds nothing left to wait for.
    asyncio.run(asyncio.wait_for(conn.close(), timeout=2))


@pytest.mark.asyncio
async def test_a_close_after_a_force_stop_still_releases_the_writer_lock(tmp_path):
    """SQLAlchemy's terminate: ``stop()`` first, then the graceful ``close()``.

    The close is refused ("Connection closed") and clears ``_connection`` in
    its ``finally`` before the worker runs the stop's sentinel. Upstream's
    sentinel then finds no handle to close, the worker exits cleanly, and a
    cursor still referencing the handle keeps its transaction open.
    """
    db = str(tmp_path / "db.sqlite")
    conn = await aiosqlite.connect(db, isolation_level=None)
    await conn.execute("BEGIN IMMEDIATE")
    cursor = await conn.execute("SELECT 1")  # keeps the sqlite handle referenced

    conn.stop()
    with pytest.raises(ValueError, match="Connection closed"):
        await conn.close()
    conn._thread.join(timeout=5)

    assert not conn._thread.is_alive()
    assert _writer_lock_is_free(db), "the stopped connection still holds the writer lock"
    del cursor


async def test_closing_a_connection_mid_write_releases_the_writer_lock(tmp_path):
    """``aiosqlite.Connection.close()`` — the call SQLAlchemy makes to close a connection —
    must end the write transaction, not just close the handle.

    Upstream's ``close()`` runs a bare ``sqlite3.Connection.close()`` on the worker. With a
    write transaction open and a cursor still holding a statement (a read not fully fetched —
    what a task cancelled mid-query leaves), SQLite defers that close: the handle turns
    zombie and keeps the writer lock until the cursor is garbage-collected. Every writer
    after it waits out busy_timeout into "database is locked", on whatever test ran next
    (CI, PR #505: three different tests in two PRs).
    """
    db = str(tmp_path / "db.sqlite")
    seed = sqlite3.connect(db)
    seed.execute("CREATE TABLE t (x)")
    seed.executemany("INSERT INTO t VALUES (?)", [(i,) for i in range(100)])
    seed.commit()
    seed.close()

    conn = await aiosqlite.connect(db, isolation_level=None)
    await conn.execute("BEGIN IMMEDIATE")
    await conn.execute("INSERT INTO t VALUES (999)")
    cursor = await conn.execute("SELECT x FROM t")
    await cursor.fetchone()  # the statement stays unfinalized: the cursor is still mid-read
    assert not _writer_lock_is_free(db)

    await conn.close()

    assert _writer_lock_is_free(db), "a closed connection still holds the writer lock"
    del cursor
