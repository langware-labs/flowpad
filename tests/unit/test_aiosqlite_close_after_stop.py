"""A close that races a force-stop must finish, not wait forever.

SQLAlchemy's ``terminate()`` shields ``aiosqlite.Connection.close()``; when a
cancel lands on it, it falls back to ``stop()``. The shielded ``close()`` then
calls ``stop()`` again in its ``finally`` and awaits the future of a sentinel
queued behind the one that already ended the worker thread — so it never
resolves. Being shielded, nothing cancels it, and the loop's shutdown hangs on
it: a TestClient whose startup timed out under writer contention sat in its
portal join for 30+ minutes (QA cycle 2026-09-23).
"""
from __future__ import annotations

import asyncio

import aiosqlite
import pytest

import flow_sdk.db.drivers.sqlite.connection  # noqa: F401 — installs the idempotent stop()

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.mark.asyncio
async def test_close_racing_a_force_stop_completes(tmp_path):
    conn = await aiosqlite.connect(str(tmp_path / "db.sqlite"))

    closing = asyncio.create_task(conn.close())  # the shielded graceful close
    await asyncio.sleep(0)  # its conn.close is queued on the worker
    conn.stop()  # the force-close fallback, queued behind it

    # The bound is the assertion: the unpatched close never finishes at all.
    done, _ = await asyncio.wait({closing}, timeout=2)
    if not done:
        closing.cancel()
    assert closing in done, "close() is waiting on a stop() the dead worker will never serve"
    closing.result()
