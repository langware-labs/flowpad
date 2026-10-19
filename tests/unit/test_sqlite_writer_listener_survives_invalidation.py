"""A cancelled write must still roll back cleanly.

The writer-lock trace listens on the engine's ``commit``/``rollback`` events. A
task cancelled inside a write leaves its connection INVALIDATED, and on such a
connection ``Connection.info`` raises ``PendingRollbackError`` — so a listener
that reads it breaks the very rollback that would recover the session. In CI
that surfaced as a 500 on an unrelated request: the next user of the session
hit ``IllegalStateChangeError``.
"""
from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from flow_sdk.db.drivers.sqlite.connection import install_pragmas_and_immediate

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.mark.asyncio
async def test_rolling_back_an_invalidated_write_does_not_raise(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'db.sqlite'}")
    install_pragmas_and_immediate(engine)
    try:
        conn = await engine.connect()
        await conn.begin()
        await conn.execute(text("SELECT 1"))
        await conn.invalidate()

        await conn.rollback()  # raised PendingRollbackError from the listener

        await conn.close()
    finally:
        await engine.dispose()
