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


@async_context
async def test_a_mirror_batch_is_one_writer_acquisition_for_all_its_rows(monkeypatch):
    """A first conversation sync mirrors thousands of hub rows. One transaction per row (plus a
    read-back of each row just found absent) cost ~8 ms a row; a batch commits them together."""
    import uuid

    from flow_sdk.builtin.conversation import Conversation

    rows = [{"id": str(uuid.uuid4()), "title": f"batched {n}"} for n in range(5)]
    taken: list[int] = []
    real = conn_mod._begin_immediate
    monkeypatch.setattr(conn_mod, "_begin_immediate", lambda conn: (taken.append(1), real(conn))[1])

    async with Conversation.mirror_batch([r["id"] for r in rows]) as found:
        assert found == {}
        for row in rows:
            await Conversation.mirror_from_hub(row, existing=None, notify=False)
    assert len(taken) == 1, f"a batch of {len(rows)} mirrors took the writer lock {len(taken)} times"
    for row in rows:
        stored = await Conversation.get_by_id(row["id"])
        assert stored is not None and stored.title == row["title"] and stored.remote is True


@async_context
async def test_a_row_the_batch_proved_absent_is_created_without_reading_for_it():
    """Each statement is a round trip to the SQLite thread, and on a busy machine they ARE the cost
    of a first sync. A row the batch read as absent cannot be there: its create neither reads for the
    row nor deletes its FTS entry. A row the batch found still reads (and updates)."""
    import uuid

    from sqlalchemy import event
    from sqlalchemy.engine import Engine

    from flow_sdk.builtin.conversation import Conversation

    held_id, new_id = str(uuid.uuid4()), str(uuid.uuid4())
    await Conversation(id=held_id, title="held").save(notify=False)
    statements: list[str] = []

    def record(conn, cursor, statement, params, context, executemany):
        statements.append(" ".join(statement.split()))

    event.listen(Engine, "before_cursor_execute", record)
    try:
        async with Conversation.mirror_batch([held_id, new_id]):
            statements.clear()  # the batch's own read of its ids
            await Conversation.mirror_from_hub({"id": new_id, "title": "new"}, existing=None, notify=False)
            created = list(statements)
            statements.clear()
            await Conversation(id=held_id, title="held again").save(notify=False)
            saved_over = list(statements)
    finally:
        event.remove(Engine, "before_cursor_execute", record)

    assert not [s for s in created if s.startswith("SELECT") and "WHERE entities.id = ?" in s], created
    assert not [s for s in created if s.startswith("DELETE FROM entities_fts")], created
    assert [s for s in saved_over if s.startswith("SELECT") and "WHERE entities.id = ?" in s], saved_over
    assert (await Conversation.get_by_id(new_id)).title == "new"
    assert (await Conversation.get_by_id(held_id)).title == "held again"


@async_context
async def test_a_mirror_batch_still_keeps_links_on_a_create_over_an_existing_row():
    """Only ids the batch itself read as absent skip the read-back. A fresh instance saved over a row
    the batch found — or a second fresh instance for an id it just created — still merges the stored
    context links instead of narrowing them."""
    import uuid

    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.db.drivers.db_base_record import TypeId

    held_id, new_id = str(uuid.uuid4()), str(uuid.uuid4())
    link = TypeId(type="project", id=str(uuid.uuid4()))
    held = Conversation(id=held_id, title="held")
    held.shared_context_entities = [link]
    await held.save(notify=False)

    async with Conversation.mirror_batch([held_id, new_id]) as found:
        assert set(found) == {held_id}
        await Conversation(id=held_id, title="re-created").save(notify=False)
        first = Conversation(id=new_id, title="new")
        first.shared_context_entities = [link]
        await first.save(notify=False)
        await Conversation(id=new_id, title="new again").save(notify=False)

    for conv_id in (held_id, new_id):
        stored = await Conversation.get_by_id(conv_id)
        assert [str(t) for t in stored.shared_context_entities or []] == [str(link)], conv_id
