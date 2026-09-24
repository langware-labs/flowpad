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
