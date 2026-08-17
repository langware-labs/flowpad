"""Real indexer subprocess for the crash-before-commit reproduction.

Run as ``python -m tests.long_tests._index_crash_worker <db_path> <root>`` with
``FS_RECORD_PATH`` pointing at the shared records (shadow ``.hash``) dir. It opens
the *same* SQLite file and records root the parent uses, then runs one ordinary
``FSIndexer.index()`` over ``<root>/docs/**/*.md``.

Two roles, selected by argv[3]:
  - ``crash``  : index, and let the parent SIGKILL it mid-run (after the first
                 real ``.hash`` sentinel is written, before the batch commit).
  - ``verify`` : index normally, then print the committed markdown row count as
                 the last stdout line.

No mocks — this is a real process doing a real index against a real DB; the
parent kills it for real to reproduce a server restart mid-index.
"""
from __future__ import annotations

import asyncio
import sys


async def _run(db_path: str, root: str, role: str) -> None:
    from flow_sdk.db.drivers.sqlite import SQLiteDBDriver
    from flow_sdk.db.drivers.db_driver import DBConfig, _driver_instances
    from flow_sdk.db.db_entity import DBEntity
    from flow_sdk.db.db_relationship import DBRelationship
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — register_all()
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
    from flow_sdk.fs_store.indexer.functions.markdown import markdown_flat_fn
    from flow_sdk.fs_store.record_types import RecordType

    driver = SQLiteDBDriver(DBConfig(database=db_path))
    _driver_instances["sqlite"] = driver
    DBEntity._db = driver
    DBRelationship._db = driver
    await driver.open()

    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))

    if role == "verify":
        n = await driver.count_entities_by_type(str(RecordType.MARKDOWN))
        print(f"MARKDOWN_ROWS={n}", flush=True)


if __name__ == "__main__":
    asyncio.run(_run(sys.argv[1], sys.argv[2], sys.argv[3]))
