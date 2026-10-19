"""An index run hands the SQLite writer lock to a writer that is waiting for it.

A fresh instance's first index (hundreds of records) starved the user's first
prompt: ``createProcess`` → ``AgenticProcess.save`` failed with ``database is
locked [SQL: BEGIN IMMEDIATE]`` while the footer read "Indexing markdown
490/947". Two things combined:

* the indexer holds the writer lock for a whole commit batch — 50 records of
  parse, wiki-link resolution reads, metadata.json writes and FTS — measured at
  0.5–10s per batch on a booting instance; and
* SQLite's busy handler is not a queue. A waiter sleeps up to 100ms between
  retries while the indexer re-takes the lock microseconds after each commit,
  so the waiter misses release after release until ``busy_timeout`` expires.
  Live: holds of ~1s, while a concurrent ``POST /graph/task`` waited 6.6s.

The contract: a writer queued on BEGIN IMMEDIATE waits for at most the record
the indexer is on — not the rest of its batch, and not a lottery on the gaps.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from flow_sdk.builtin.task import Task
from flow_sdk.db import get_db_driver
from flow_sdk.db.drivers.sqlite import connection as sqlite_connection
from flow_sdk.fs_store import fs_record as fs_record_mod
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.walkers.generic import walker_for
from flow_sdk.fs_store.record_types import RecordType

# The writer arrives at record 2. Without the hand-over it sits behind every
# record after that (the run's single trailing commit), so any count from 4 up
# tells the two apart.
_DOCS = 10


@pytest.mark.asyncio
async def test_waiting_writer_is_served_within_one_record(tmp_path: Path, monkeypatch) -> None:
    docs = tmp_path / "proj" / "docs"
    docs.mkdir(parents=True)
    for i in range(_DOCS):
        (docs / f"d{i}.md").write_text(f"# doc {i}\n\nbody\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    synced = 0
    in_transaction = asyncio.Event()
    original_sync = fs_record_mod.FSRecord.sync_to_db

    async def counting_sync(self, *args, **kwargs):
        nonlocal synced
        await original_sync(self, *args, **kwargs)
        synced += 1
        # Two records in: the indexer's batch transaction is open and holding
        # the writer lock.
        if synced == 2:
            in_transaction.set()

    monkeypatch.setattr(fs_record_mod.FSRecord, "sync_to_db", counting_sync)

    indexer = FSIndexer()
    indexer.add_root(FSRef(tmp_path / "proj", record_type=RecordType.USER_HOME_FOLDER))
    indexer.add_function(RecordType.USER_HOME_FOLDER, walker_for("markdown"))
    index_run = asyncio.create_task(indexer.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN])))

    # Every BEGIN IMMEDIATE the interactive write issues, and how many records
    # the indexer synced while it was blocked there. A save is several writer
    # transactions, so the bound is per acquisition, not per save.
    writer_name = "interactive-write"
    blocked_for: list[int] = []
    real_begin = sqlite_connection._begin_immediate

    def timed_begin(conn):
        task = asyncio.current_task()
        started = synced
        real_begin(conn)
        if task is not None and task.get_name() == writer_name:
            blocked_for.append(synced - started)

    monkeypatch.setattr(sqlite_connection, "_begin_immediate", timed_begin)
    await in_transaction.wait()
    # An interactive write — its own fresh writer sessions, the way a request
    # saving an AgenticProcess arrives while the index runs.
    await asyncio.create_task(Task(title="written during index").save(), name=writer_name)
    result = await index_run

    assert result.per_type[RecordType.MARKDOWN].indexed == _DOCS
    assert blocked_for, "the interactive write never reached BEGIN IMMEDIATE"
    assert max(blocked_for) <= 1, (
        f"a write transaction stayed blocked while the indexer synced {max(blocked_for)} more records "
        f"(per acquisition: {blocked_for}) — the indexer kept the writer lock instead of handing it "
        "over at the next record"
    )
    assert sqlite_connection.writers_waiting() == 0
