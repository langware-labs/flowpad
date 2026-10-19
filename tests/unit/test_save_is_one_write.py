"""A save takes the SQLite writer lock once, and announces what it wrote after it commits.

While an index runs, every ``BEGIN IMMEDIATE`` waits for the record the indexer
holds (``yield_to_waiting_writers``): a save that opened one transaction for its
row and another for its FTS entry waited two records — a cold-boot first prompt
waited seconds. And an announcement sent from inside the transaction lets a
listener read the row before it is there.
"""
from __future__ import annotations

import asyncio
import contextvars

from flow_sdk.db.drivers.sqlite import connection as conn_mod
from tests.pytest_plugin import async_context


@async_context
async def test_a_save_is_one_writer_acquisition(monkeypatch):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    taken: list[int] = []
    real = conn_mod._begin_immediate
    monkeypatch.setattr(conn_mod, "_begin_immediate", lambda conn: (taken.append(1), real(conn))[1])

    process = AgenticProcess(name="one-write", visible=False)
    await process.save()
    assert len(taken) == 1, f"a create took the writer lock {len(taken)} times"

    taken.clear()
    process.name = "renamed"
    await process.update()
    assert len(taken) == 1, f"an update took the writer lock {len(taken)} times"


@async_context
async def test_the_announcement_comes_after_the_commit(monkeypatch):
    """A listener that reads the row when it hears of it finds it — from another
    connection, so it sees only what is committed."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.db import db_entity
    from flow_sdk.db import session

    seen: list[object] = []

    async def read(op_message):
        async with session(write=False):
            seen.append(await AgenticProcess.get_by_id(op_message.to_entity.id))

    async def listener(op_message):
        # An empty context: a listener elsewhere shares none of the saver's
        # session, so it sees only what has been committed.
        await asyncio.create_task(read(op_message), context=contextvars.Context())

    real = db_entity.DBEntity.add_entity_op_notification

    async def announce(op_message, notify_immediately=False):
        await listener(op_message)
        await real(op_message, notify_immediately)

    monkeypatch.setattr(db_entity.DBEntity, "add_entity_op_notification", staticmethod(announce))
    process = await AgenticProcess(name="announced", visible=False).save()

    assert seen and seen[0] is not None and seen[0].id == process.id, "the row was announced before it existed"


@async_context
async def test_seeding_the_capabilities_is_one_writer_acquisition(monkeypatch):
    """The first capability lookup on a fresh instance writes every row. It did
    so one save at a time, so the first request during a boot index waited a
    record per row (a task create: 20 acquisitions, 2.6s behind a slow index)."""
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.db import get_db_driver

    await get_db_driver().delete_entities_by_type(Capability.get_type())
    Capability._seeded_dbs.discard(Capability._db)
    taken: list[int] = []
    real = conn_mod._begin_immediate
    monkeypatch.setattr(conn_mod, "_begin_immediate", lambda conn: (taken.append(1), real(conn))[1])

    seeded = await Capability.ensure_seeded()

    assert len(seeded) > 1, "the sweep wrote nothing — the test proves nothing"
    assert len(taken) == 1, f"seeding {len(seeded)} rows took the writer lock {len(taken)} times"
