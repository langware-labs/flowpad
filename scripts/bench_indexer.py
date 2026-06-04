"""End-to-end indexer benchmark: with vs without TranscriptIndexer wired in.

Walks the real ~/.claude tree. Runs each variant 3 times, reports cold and
warm (skip-fresh) pass durations.
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.claude_projects import claude_projects_fn
from flow_sdk.fs_store.indexer.functions.claude_sessions import claude_sessions_fn
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.transcript_indexer import TranscriptIndexer
from flow_sdk.fs_store.transcript_indexer.handlers import PlanHandler

HOME = Path.home()


def _build_idx(with_ti: bool) -> FSIndexer:
    idx = FSIndexer(
        roots=[FSRef(HOME, record_type=RecordType.USER_HOME_FOLDER, scope="user")]
    )
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn)
    idx.add_function(RecordType.PROJECT, claude_sessions_fn)
    if with_ti:
        ti = TranscriptIndexer()
        ti.add_handler(PlanHandler())
        idx.add_function(RecordType.CLAUDE_SESSION, ti)
    return idx


async def _wipe() -> None:
    driver = get_db_driver()
    for rt in (RecordType.CLAUDE_SESSION, RecordType.PROJECT):
        await driver.delete_entities_by_type(str(rt))


async def _time_index(idx: FSIndexer, force: bool = False) -> tuple[float, int, int]:
    t0 = time.perf_counter()
    r = await idx.index(IndexerOptions(verbose=False, force=force))
    dt = time.perf_counter() - t0
    sessions = r.per_type.get(RecordType.CLAUDE_SESSION)
    indexed = sessions.indexed if sessions else 0
    skipped = sessions.skipped if sessions else 0
    return dt, indexed, skipped


async def main() -> None:
    print(f"HOME: {HOME}")

    for label, with_ti in (("baseline (no TranscriptIndexer)", False),
                           ("with TranscriptIndexer + PlanHandler", True)):
        print()
        print(f"── {label} " + "─" * (76 - len(label)))
        await _wipe()
        idx = _build_idx(with_ti=with_ti)

        # cold pass (fresh DB)
        dt, indexed, skipped = await _time_index(idx)
        print(f"  cold pass:     {dt*1000:8.1f} ms  CLAUDE_SESSION indexed={indexed} skipped={skipped}")

        # warm pass 1 (everything should skip-fresh)
        dt, indexed, skipped = await _time_index(idx)
        print(f"  warm pass 1:   {dt*1000:8.1f} ms  CLAUDE_SESSION indexed={indexed} skipped={skipped}")

        # warm pass 2 (confirm steady-state)
        dt, indexed, skipped = await _time_index(idx)
        print(f"  warm pass 2:   {dt*1000:8.1f} ms  CLAUDE_SESSION indexed={indexed} skipped={skipped}")

        # force pass (bypass freshness — worst case for TI)
        dt, indexed, skipped = await _time_index(idx, force=True)
        print(f"  force pass:    {dt*1000:8.1f} ms  CLAUDE_SESSION indexed={indexed} skipped={skipped}")


if __name__ == "__main__":
    asyncio.run(main())
