"""A file deleted outside an editor leaves the index, and the clients are told.

A session's ``rm`` is invisible to the transcript (only Write/Edit name a path), so
its rows used to linger until the next full index — and that index reaped them
without a DELETE op, so open trees kept listing files that were gone.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.api.api_types.messages import OperationType
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess, _ran_shell_command
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db import get_db_driver
from flow_sdk.db.db_entity import DBEntity
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.walkers.generic import walker_for
from flow_sdk.fs_store.orphan_removal import remove_orphan_row
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.reindex import sources_gone_under
from flow_sdk.transcript_analyzer.entries.shell_command import ShellCommandEntry


@pytest.fixture
def ops(monkeypatch) -> list:
    seen: list = []

    async def record(op, notify_immediately: bool = False):
        seen.append(op)

    monkeypatch.setattr(DBEntity, "add_entity_op_notification", staticmethod(record))
    return seen


async def _indexed_doc(tmp_path: Path) -> tuple[Path, Path, str]:
    root = tmp_path / "proj"
    (root / "docs").mkdir(parents=True)
    doc = root / "docs" / "a.md"
    doc.write_text("# a\n", encoding="utf-8")
    await get_db_driver().delete_entities_by_type(str(RecordType.MARKDOWN))
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_function(RecordType.USER_HOME_FOLDER, walker_for("markdown"))
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    row = await Entity.get_by_asset_ref(str(doc), resolve_containing=False, strict=True)
    assert row is not None
    return root, doc, str(row.id)


def _deletes(ops: list, entity_id: str) -> list:
    return [o for o in ops if o.op == OperationType.DELETE.value and str(o.to_entity.id) == entity_id]


@pytest.mark.asyncio
async def test_reaping_a_row_sends_one_delete(tmp_path: Path, ops: list) -> None:
    _, _, eid = await _indexed_doc(tmp_path)
    ops.clear()

    assert await remove_orphan_row(eid, "markdown") is True
    assert len(_deletes(ops, eid)) == 1

    ops.clear()
    assert await remove_orphan_row(eid, "markdown") is False  # nothing left to reap
    assert ops == []


@pytest.mark.asyncio
async def test_turn_end_reaps_a_file_removed_by_the_shell(tmp_path: Path, ops: list) -> None:
    root, doc, eid = await _indexed_doc(tmp_path)
    doc.unlink()  # an `rm`: no Write/Edit entry names it
    ops.clear()

    process = SimpleNamespace(id="test-process")
    await AgenticProcess._reindex_touched(process, [], sweep_root=str(root))

    assert await Entity.get_by_asset_ref(str(doc), resolve_containing=False, strict=True) is None
    assert len(_deletes(ops, eid)) == 1


@pytest.mark.asyncio
async def test_no_sweep_of_home_or_above() -> None:
    from flow_sdk.instance_settings import get_instance_settings

    home = Path(get_instance_settings().user_home)
    assert await sources_gone_under(home) == []
    assert await sources_gone_under(home.anchor) == []


def test_only_a_shell_command_triggers_the_sweep() -> None:
    shell = ShellCommandEntry.__new__(ShellCommandEntry)
    assert _ran_shell_command([shell]) is True
    assert _ran_shell_command([object()]) is False
