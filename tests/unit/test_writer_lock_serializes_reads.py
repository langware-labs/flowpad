"""RCA reproduction — createProcess blows the 4s interactive budget because its
DB reads serialize on the SQLite writer lock.

Proven root cause (2026-06-15): on a busy instance every createProcess DB op
serializes on SQLite's single writer lock. The reads are the surprise —
``next_tab_order``=``Shell.get_all`` (12.8s) and ``get_local_cn`` (8.5s) run on
the **write** session, which fires ``BEGIN IMMEDIATE`` (connection.py
``_on_begin``) and queues behind whatever writer holds the lock (the recovery
watchdog continuously saving ~16 sessions, or an indexer batch — see the
connection.py docstring: "a long-running writer froze every read").

This test REPRODUCES the hang at the narrowest layer (the real ``SQLiteDBDriver``
on a real WAL DB, no mocks): a background writer holds the lock the way the
recovery watchdog does, and the createProcess-representative read (issued on the
write session, exactly like ``next_tab_order``/``get_local_cn``) is asserted to
meet the 4s interactive budget. It does NOT — it blocks for the whole contention
window — so the test FAILS with the bug's signature, just like createProcess on
:9007.

The fix (route those reads through ``reader_session_factory`` /
``FLOW_WRITER_OPT=False``) makes this pass — see the reader-session control below,
which is instant against the same held lock. NOT applied here.

NOTE: ``CONTENTION_S`` is the controlled writer load (the switch), not a widened
wait/timeout to mask a symptom. The 30s cap stands and is never raised.
"""
from __future__ import annotations

import asyncio
import time

import pytest
from sqlalchemy import text

from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver

BUDGET_MS = 4000  # interactive budget: a createProcess DB read must beat this
CONTENTION_S = 5.0  # how long the background writer holds the lock (< observed 8-13s on :9007)


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_createprocess_read_exceeds_4s_under_writer_lock(tmp_path):
    driver = SQLiteDBDriver(DBConfig(database=str(tmp_path / "rca.db")))
    await driver.open()
    try:
        async with driver.session_factory() as s:
            await s.execute(text("CREATE TABLE IF NOT EXISTS t(x)"))
            await s.commit()

        lock_held = asyncio.Event()
        release = asyncio.Event()

        async def recovery_watchdog_writer():
            # Models the recovery watchdog / indexer batch: a write session that
            # owns the writer lock (BEGIN IMMEDIATE on first execute) for the window.
            async with driver.session_factory() as s:
                await s.execute(text("INSERT INTO t(x) VALUES (1)"))
                lock_held.set()
                await release.wait()
                await s.rollback()

        holder = asyncio.create_task(recovery_watchdog_writer())
        await lock_held.wait()

        # Control: the SAME read on the READER session is instant — proves the fix.
        t0 = time.perf_counter()
        async with driver.reader_session_factory() as s:
            await s.execute(text("SELECT 1"))
        reader_ms = (time.perf_counter() - t0) * 1000

        # The createProcess path: next_tab_order / get_local_cn read on the WRITE
        # session → BEGIN IMMEDIATE → blocked behind the held writer lock.
        async def createprocess_path_read():
            t = time.perf_counter()
            async with driver.session_factory() as s:
                await s.execute(text("SELECT 1"))
            return (time.perf_counter() - t) * 1000

        read_task = asyncio.create_task(createprocess_path_read())
        await asyncio.sleep(CONTENTION_S)  # writer holds the lock this long
        release.set()
        read_ms = await read_task
        await holder

        print(
            f"[writer-lock RCA] reader(fixed)={reader_ms:.0f}ms  "
            f"write(createProcess path)={read_ms:.0f}ms  budget={BUDGET_MS}ms"
        )

        # The bug: the interactive read is serialized behind the writer lock and
        # misses the 4s budget. This assertion FAILS on the current code path —
        # that failure IS the createProcess hang reproduced.
        assert read_ms < BUDGET_MS, (
            f"createProcess-path read took {read_ms:.0f}ms (> {BUDGET_MS}ms budget) — "
            f"serialized behind the writer lock; the reader session did it in "
            f"{reader_ms:.0f}ms, which is the fix"
        )
    finally:
        await driver.close()
