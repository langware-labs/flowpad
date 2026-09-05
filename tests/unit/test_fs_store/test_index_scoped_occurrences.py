"""A scoped index re-validates only the stored occurrences it can change.

The collision resolver re-reads the identity carrier of every stored occurrence
it is handed. Handing a project-scoped run the whole corpus priced a one-file
project index at one frontmatter read per record on the machine — and the
auto-index fires one such run per project selection.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.walkers.generic import walker_for
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import TypeInfo


def _indexer(*roots: Path) -> FSIndexer:
    idx = FSIndexer()
    for root in roots:
        idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, walker_for("markdown"))
    return idx


@pytest.mark.asyncio
async def test_scoped_run_does_not_reread_other_roots_records(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inside = tmp_path / "inside"
    outside = tmp_path / "outside"
    (inside / "docs").mkdir(parents=True)
    (outside / "docs").mkdir(parents=True)
    (inside / "docs" / "a.md").write_text("# a\n", encoding="utf-8")
    (outside / "docs" / "b.md").write_text("# b\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))
    # Seed rows (and stored occurrences) for both roots.
    seeded = await _indexer(inside, outside).index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    assert seeded.per_type[RecordType.MARKDOWN].indexed == 2

    reread: list[str] = []
    original = TypeInfo._read_carrier

    def spy(self, ref, *args, **kwargs):
        reread.append(str(ref._path))
        return original(self, ref, *args, **kwargs)

    monkeypatch.setattr(TypeInfo, "_read_carrier", spy)

    outside_md = str(outside / "docs" / "b.md")

    # Scoped to `inside`: the other root's record is neither walked nor re-read.
    reread.clear()
    await _indexer(inside).index(
        IndexerOptions(
            verbose=False,
            types=[RecordType.MARKDOWN],
            roots=(FSRef(inside, record_type=RecordType.USER_HOME_FOLDER),),
        )
    )
    assert not [p for p in reread if p.startswith(outside_md)]

    # Unscoped with only `inside` registered: the full view is kept, so the
    # stored occurrence under `outside` is still re-validated.
    reread.clear()
    await _indexer(inside).index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    assert [p for p in reread if p.startswith(outside_md)]
