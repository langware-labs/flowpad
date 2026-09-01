"""``Dataset.save()`` lands on disk — the phase-2 proof.

Before the serializer became the save path, a saved Dataset never reached disk:
it had no ``default_body_fn``, so ``Entity.save()`` wrote only the shadow index.
Now the serializer writes the manifest, the rows, and commits the folder
capsule, and the same folder reads back through ``from_fs_ref`` with the same id.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from flow_sdk.builtin.dataset import ARTIFACT_ROW, Dataset
from flow_sdk.capsules import AssetCapsule
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec.dataset_spec import DataLayoutEnum, ExampleKind, FileRef, TextSpec
from flow_sdk.schema.type_info import register_all

pytestmark = pytest.mark.timeout(10)  # do not increase without approval


@pytest.fixture
def scope(tmp_path, monkeypatch) -> Path:
    register_all()
    root = tmp_path / "scope"
    root.mkdir()
    monkeypatch.setattr(Entity, "_resolve_scope_root", AsyncMock(return_value=root))
    monkeypatch.setattr(Entity, "_resolve_repo_parent_container", AsyncMock(return_value=None))
    return root


@pytest.mark.asyncio
async def test_dataset_save_writes_manifest_rows_and_capsule(sync_db, tmp_records_root, scope) -> None:
    # `description` is a blob field (needs an embedded VFS); the manifest proof
    # does not need it, so it stays at its default.
    ds = Dataset(
        name="trainset", title="T", data_layout=DataLayoutEnum.CSV,
        examples=[ARTIFACT_ROW(kind=ExampleKind.TRAIN, input=TextSpec(text="q"), ground_truth=TextSpec(text="a"))],
    )
    await ds.save(notify=False)

    folder = scope / "agentic-assets" / "dataset" / "trainset"
    manifest = json.loads((folder / "dataset.json").read_text())
    assert manifest["metadata"]["title"] == "T" and manifest["metadata"]["data_layout"] == "csv"
    assert "num_examples" not in manifest["metadata"]        # counts are the indexer's, never authored
    assert (folder / "data.csv").read_text().splitlines()[1].endswith("q,a")
    assert AssetCapsule.from_path(folder).read("identity").data["id"] == ds.id

    back = Dataset.from_fs_ref(FSRef(folder))
    assert back is not None and back.id == ds.id and back.num_examples == 1
    # get_all, not get_one: get_one expands blob fields (`description`), which
    # needs an embedded VFS this unit test has no reason to stand up.
    rows = await Dataset.get_all({"id": ds.id})
    assert len(rows) == 1 and rows[0].num_examples == 1 and rows[0].examples == []   # DB-excluded rows


@pytest.mark.asyncio
async def test_dataset_save_io_folder_writes_example_dirs(sync_db, tmp_records_root, scope) -> None:
    """Rows that reference files which do not exist yet: the example dir and its
    ``example.json`` are written, the missing bytes are created empty — the row
    is a declaration, and a later ``contents``/``source`` fills it."""
    ds = Dataset(
        name="io", data_layout=DataLayoutEnum.IO_FOLDER,
        examples=[ARTIFACT_ROW(kind=ExampleKind.EVAL, input=FileRef(path="input.txt"),
                               output=[FileRef(path="output-1.txt"), FileRef(path="output-2.txt")])],
    )
    await ds.save(notify=False)
    ex = scope / "agentic-assets" / "dataset" / "io" / "examples" / "0001"
    assert (ex / "input.txt").exists() and (ex / "output-2.txt").exists()
    assert json.loads((ex / "example.json").read_text())["metadata"]["kind"] == "eval"
    assert Dataset.from_fs_ref(FSRef(ex.parent.parent)).num_examples == 1


@pytest.mark.asyncio
async def test_a_second_save_is_idempotent_on_disk(sync_db, tmp_records_root, scope) -> None:
    ds = Dataset(name="twice", title="T")
    await ds.save(notify=False)
    manifest = scope / "agentic-assets" / "dataset" / "twice" / "dataset.json"
    before = manifest.stat().st_mtime_ns
    await ds.save(notify=False)
    assert manifest.stat().st_mtime_ns == before                # a no-op save must not churn the hash sentinel


@pytest.mark.asyncio
async def test_indexer_computed_counts_lift_from_the_shadow(sync_db, tmp_records_root, scope, monkeypatch) -> None:
    """The derived meta model = header ∪ Persist.TRUE: the counts the indexer
    computes are NOT header fields, and they must still ride the shadow and
    lift onto the DB row through ``from_record``. Regression pin for the
    meta_model derivation."""
    from flow_sdk.fs_store.fs_ref import FSRef

    ds = Dataset(name="counts", examples=[
        ARTIFACT_ROW(input=TextSpec(text=f"q{i}"), ground_truth=TextSpec(text="a")) for i in range(3)
    ])
    await ds.save(notify=False)
    folder = scope / "agentic-assets" / "dataset" / "counts"
    (rec,) = SchemaRegistry.get("dataset").from_disk_fn(FSRef(folder), ds.id)
    assert rec.meta_dict()["num_annotated"] == 3
    # from_record expands blob fields (`description`), which needs an embedded
    # VFS; this pin is about count LIFTING, so blobs stay unexpanded.
    monkeypatch.setattr(Entity, "expand_blobs", AsyncMock(return_value=None))
    row = await Entity.from_record(rec, notify=False)
    assert row.num_examples == 3 and row.num_annotated == 3
