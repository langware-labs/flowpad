"""A freshly-created project must NOT read as ``never_indexed``.

Bug: creating a Project persists the entity but never builds/stamps its index,
so the project record has no ``.hash`` sentinel. ``index_log.get_index_status``
scoped to that project then reports ``never_indexed=True`` (``indexed_at is None``),
which drives the UI's "no index / Build Index" warning + modal on a brand-new,
empty project.

Proven on/off switch (this session): the project record's ``.hash`` sentinel.
Stamp it via ``FSRecord.write_hash()`` -> ``never_indexed`` flips to False;
clear it -> flips back to True. Creation should stamp it (empty project = fast).

Faithful reproduction — real ``Project.save()`` + real ``get_index_status``, no
mocks of the record/sentinel/status under test.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.indexer import index_log
from flow_sdk.fs_store.record_paths import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)


@pytest.fixture(autouse=True)
def _tmp_records_root(tmp_path: Path, monkeypatch):
    """Isolate the records root so a real Project.save() lands in tmp."""
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    orig_root = get_default_records_root()
    orig_data_root = get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    try:
        yield tmp_path
    finally:
        set_default_records_root(orig_root)
        set_default_records_data_root(orig_data_root)


@pytest.mark.asyncio
async def test_new_project_is_not_never_indexed(tmp_path: Path):
    project_root = tmp_path / "proj_src"
    project_root.mkdir(parents=True, exist_ok=True)

    pid = str(uuid.uuid4())
    proj = Project(id=pid, name="fresh_proj", fs_storage_mount_path=str(project_root))
    await proj.save()

    scope = SimpleNamespace(projects=[pid])
    status = await index_log.get_index_status(scope=scope)

    # A brand-new (empty) project is trivially "indexed" — it must not trip the
    # "no index / Build Index" warning. Fails today: creation never stamps the
    # project record's .hash sentinel, so indexed_at is None -> never_indexed True.
    assert status.never_indexed is False
    assert status.last_indexed_at is not None
