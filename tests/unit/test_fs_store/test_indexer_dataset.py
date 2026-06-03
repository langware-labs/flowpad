"""Indexer tests for the DATASET type.

Covers both physical layouts (``CSV`` and ``IO_FOLDER``) end-to-end through the
slot functions:
- ``dataset_fn`` walker emits one FSRef per ``assets/datasets/<slug>/`` folder.
- ``extract_dataset`` parses the manifest + rows into one FSRecord with counts.
- ``iter_examples`` normalizes both layouts into the shared ``Example`` shape.
- ``dataset_gen_id`` adopts a valid manifest id else mints a stable uuid5.

Pure-sync (no scan needed): the walker is called directly with a project node.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.dataset import DataLayoutEnum, ExampleKind
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.indexer.functions.dataset import (
    dataset_asset_hash,
    dataset_fn,
    dataset_gen_id,
    extract_dataset,
    iter_examples,
)
from flow_sdk.fs_store.record_types import RecordType

# do not increase timeout without approval — these are pure-sync parses (<1s).
pytestmark = pytest.mark.timeout(5)


# ── fixtures ──────────────────────────────────────────────────────────────────

def _seed_csv_dataset(
    project: Path,
    slug: str,
    *,
    manifest: dict,
    csv_text: str,
) -> Path:
    ds = project / "assets" / "datasets" / slug
    ds.mkdir(parents=True)
    (ds / "dataset.json").write_text(json.dumps(manifest), encoding="utf-8")
    (ds / "data.csv").write_text(csv_text, encoding="utf-8")
    return ds


def _seed_io_dataset(
    project: Path,
    slug: str,
    *,
    examples: dict[str, dict],
    manifest: dict | None = None,
) -> Path:
    ds = project / "assets" / "datasets" / slug
    (ds / "examples").mkdir(parents=True)
    (ds / "dataset.json").write_text(
        json.dumps(manifest or {"data_layout": "io_folder"}), encoding="utf-8"
    )
    for name, spec in examples.items():
        ex = ds / "examples" / name
        ex.mkdir()
        (ex / "input.txt").write_text(spec["input"], encoding="utf-8")
        if "expected" in spec:
            (ex / "expected.txt").write_text(spec["expected"], encoding="utf-8")
        if "meta" in spec:
            (ex / "meta.json").write_text(json.dumps(spec["meta"]), encoding="utf-8")
    return ds


# ── CSV layout ────────────────────────────────────────────────────────────────

def test_csv_happy_path(tmp_path: Path) -> None:
    ds = _seed_csv_dataset(
        tmp_path,
        "qa",
        manifest={"title": "QA set", "data_layout": "csv"},
        csv_text=(
            "kind,input,expected\n"
            "train,2+2,4\n"
            "train,3+3,6\n"
            "eval,9+1,10\n"
        ),
    )
    records = extract_dataset(FSRef(ds))
    assert len(records) == 1
    rec = records[0]
    assert rec.type == RecordType.DATASET
    assert rec.name == "QA set"
    meta = rec.meta_dict()["metadata"]
    assert meta["num_examples"] == 3
    assert meta["kind_counts"] == {"train": 2, "eval": 1}


def test_csv_field_spec_maps_columns(tmp_path: Path) -> None:
    """Non-canonical headers (question/answer) mapped via field_spec; leftover
    columns land in Example.metadata."""
    ds = _seed_csv_dataset(
        tmp_path,
        "mapped",
        manifest={
            "data_layout": "csv",
            "field_spec": {"input": "question", "expected": "answer"},
        },
        csv_text=(
            "question,answer,difficulty\n"
            "capital of France?,Paris,easy\n"
        ),
    )
    rows = iter_examples(
        ds,
        DataLayoutEnum.CSV,
        {"input": "question", "expected": "answer"},
        ",",
        dataset_id="ds-1",
    )
    assert len(rows) == 1
    assert rows[0].input == "capital of France?"
    assert rows[0].expected == "Paris"
    assert rows[0].metadata == {"difficulty": "easy"}
    assert rows[0].kind == ExampleKind.TRAIN  # no kind column → default


# ── IO_FOLDER layout ──────────────────────────────────────────────────────────

def test_io_folder_happy_path(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path,
        "io",
        examples={
            "0001": {"input": "hello", "expected": "world", "meta": {"kind": "eval"}},
            "0002": {"input": "foo", "expected": "bar"},
        },
    )
    records = extract_dataset(FSRef(ds))
    assert len(records) == 1
    meta = records[0].meta_dict()["metadata"]
    assert meta["num_examples"] == 2
    assert meta["kind_counts"] == {"eval": 1, "train": 1}

    rows = iter_examples(ds, DataLayoutEnum.IO_FOLDER, {}, ",", dataset_id="ds-io")
    by_name = {r.metadata.get("kind", "train"): r for r in rows}
    assert by_name["eval"].input == "hello"
    assert by_name["eval"].expected == "world"
    assert by_name["eval"].kind == ExampleKind.EVAL


def test_io_folder_missing_expected_is_none(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path,
        "unlabeled",
        examples={"0001": {"input": "prompt only"}},
    )
    rows = iter_examples(ds, DataLayoutEnum.IO_FOLDER, {}, ",", dataset_id="ds-u")
    assert len(rows) == 1
    assert rows[0].input == "prompt only"
    assert rows[0].expected is None


# ── walker ────────────────────────────────────────────────────────────────────

def test_dataset_fn_emits_one_ref_per_folder(tmp_path: Path) -> None:
    _seed_csv_dataset(tmp_path, "A", manifest={"data_layout": "csv"}, csv_text="input\nx\n")
    _seed_csv_dataset(tmp_path, "B", manifest={"data_layout": "csv"}, csv_text="input\ny\n")
    # A folder without dataset.json must be skipped.
    (tmp_path / "assets" / "datasets" / "no-manifest").mkdir(parents=True)

    node = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD)
    refs = dataset_fn([node], IndexerOptions(verbose=False))

    assert len(refs) == 2
    assert all(r.record_type == RecordType.DATASET for r in refs)
    names = sorted(Path(r.path).name for r in refs)
    assert names == ["A", "B"]


def test_dataset_fn_no_datasets_dir(tmp_path: Path) -> None:
    node = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD)
    assert dataset_fn([node], IndexerOptions(verbose=False)) == []


# ── id minting ────────────────────────────────────────────────────────────────

def test_gen_id_adopts_valid_manifest_id(tmp_path: Path) -> None:
    valid = str(uuid.uuid4())  # v4 → adoptable
    ds = _seed_csv_dataset(
        tmp_path, "adopt", manifest={"id": valid, "data_layout": "csv"}, csv_text="input\nx\n"
    )
    assert dataset_gen_id(FSRef(ds)) == valid


def test_gen_id_derives_stable_uuid5_when_absent(tmp_path: Path) -> None:
    ds = _seed_csv_dataset(tmp_path, "derive", manifest={"data_layout": "csv"}, csv_text="input\nx\n")
    first = dataset_gen_id(FSRef(ds))
    second = dataset_gen_id(FSRef(ds))
    assert first == second  # idempotent
    assert uuid.UUID(first).version == 5


def test_gen_id_ignores_foreign_id_version(tmp_path: Path) -> None:
    """A non-v4/v5 id (e.g. a hand-authored v7) must be ignored, not adopted."""
    v7 = "018f5b2a-7c00-7000-8000-000000000000"  # version nibble = 7
    ds = _seed_csv_dataset(
        tmp_path, "v7", manifest={"id": v7, "data_layout": "csv"}, csv_text="input\nx\n"
    )
    minted = dataset_gen_id(FSRef(ds))
    assert minted != v7
    assert uuid.UUID(minted).version == 5


# ── example id determinism ────────────────────────────────────────────────────

def test_asset_hash_tracks_inner_file_edits(tmp_path: Path) -> None:
    """A folder's own mtime doesn't move on inner-content edits, so the hash must
    track data.csv (CSV) and the example files (IO_FOLDER) directly."""
    csv_ds = _seed_csv_dataset(
        tmp_path, "csv", manifest={"data_layout": "csv"}, csv_text="input\nx\n"
    )
    before = dataset_asset_hash(FSRef(csv_ds))
    import os
    os.utime(csv_ds / "data.csv", (before + 100, before + 100))
    assert dataset_asset_hash(FSRef(csv_ds)) > before

    io_ds = _seed_io_dataset(tmp_path, "io", examples={"0001": {"input": "a", "expected": "b"}})
    before_io = dataset_asset_hash(FSRef(io_ds))
    os.utime(io_ds / "examples" / "0001" / "input.txt", (before_io + 100, before_io + 100))
    assert dataset_asset_hash(FSRef(io_ds)) > before_io


def test_example_id_is_deterministic(tmp_path: Path) -> None:
    ds = _seed_csv_dataset(
        tmp_path, "det", manifest={"data_layout": "csv"}, csv_text="input\na\nb\n"
    )
    rows1 = iter_examples(ds, DataLayoutEnum.CSV, {}, ",", dataset_id="ds-X")
    rows2 = iter_examples(ds, DataLayoutEnum.CSV, {}, ",", dataset_id="ds-X")
    assert [r.id for r in rows1] == [r.id for r in rows2]
    assert rows1[0].id == str(uuid.uuid5(uuid.NAMESPACE_DNS, "ds-X:0"))
