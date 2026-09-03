"""``annotated`` has ONE definition.

``Dataset.num_annotated`` is counted twice: by the indexer over the parsed rows
(a reindex) and by the entity from the cheap per-example index (after a label).
The index used to test ``ground_truth/`` alone, so a ``ground_truth.txt``, a
numbered ``ground_truth-1/`` or a legacy ``expected.txt`` counted on one path
and not the other, and the card's count changed with whichever ran last.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.fs_store.indexer.functions.dataset import derive_dataset, iter_examples
from flow_sdk.schema.data_spec.dataset_spec import DataLayoutEnum, FileRef, FolderSpec, TextSpec
from flow_sdk.schema.data_spec.layout import FolderLayout, layout_for

#: name → (files to write, annotated?)
VARIANTS = {
    "gt_dir":      ({"ground_truth/label.json": '{"a": 1}'}, True),
    "gt_numbered": ({"ground_truth-1/label.json": '{"a": 1}'}, True),
    "gt_file":     ({"ground_truth.txt": "gold"}, True),
    "legacy":      ({"expected.txt": "gold"}, True),
    "sidecar_only": ({"ground_truth.json": '{"metadata": {}, "data": {}}'}, False),  # a sidecar is not DATA
    "unlabelled":  ({}, False),
}


def _seed(root: Path) -> Path:
    ds = root / "ds"
    (ds / "examples").mkdir(parents=True)
    (ds / "dataset.json").write_text(json.dumps({"metadata": {"data_layout": "io_folder"}, "data": {}}))
    for name, (files, _) in VARIANTS.items():
        ex = ds / "examples" / name
        ex.mkdir()
        (ex / "input.txt").write_text("in")
        for rel, body in files.items():
            (ex / rel).parent.mkdir(parents=True, exist_ok=True)
            (ex / rel).write_text(body)
    return ds


def test_each_variant_counts_once_on_both_paths(tmp_path):
    ds = _seed(tmp_path)
    expected = {name: flag for name, (_, flag) in VARIANTS.items()}

    # the entity's path: the per-example index
    rows = layout_for(DataLayoutEnum.IO_FOLDER).index(ds, dataset_id="d")
    by_name = dict(zip(sorted(VARIANTS), (r["annotated"] for r in rows)))
    assert by_name == expected

    # the indexer's path: the extractor over the parsed rows
    data = {"data_layout": "io_folder", "examples": iter_examples(ds, DataLayoutEnum.IO_FOLDER, {}, ",", dataset_id="d")}
    derive_dataset(data, ds, {})
    assert data["num_annotated"] == sum(expected.values()) == 4


def test_the_index_flag_is_exactly_whether_the_reader_emits_gold(tmp_path):
    ds = _seed(tmp_path)
    layout = FolderLayout()
    for ex_dir in sorted((ds / "examples").iterdir()):
        row = layout.read_example(ex_dir)
        assert layout.has_ground_truth(ex_dir) == (row.get("ground_truth") is not None), ex_dir.name


def test_a_csv_row_is_annotated_by_its_gold_cell(tmp_path):
    """The base rule, for the layout with no per-example directories: a row
    is annotated when the reader gave it a gold cell (the column exists)."""
    (tmp_path / "data.csv").write_text("input\na\nb\n")
    data = {"data_layout": "csv", "examples": iter_examples(tmp_path, DataLayoutEnum.CSV, {}, ",", dataset_id="d")}
    derive_dataset(data, tmp_path, {})
    assert data["num_annotated"] == 0
    (tmp_path / "data.csv").write_text("input,expected\na,1\nb,2\n")
    data = {"data_layout": "csv", "examples": iter_examples(tmp_path, DataLayoutEnum.CSV, {}, ",", dataset_id="d")}
    derive_dataset(data, tmp_path, {})
    assert data["num_annotated"] == 2


@pytest.mark.parametrize("value", [
    FileRef(path="input.txt"),
    FolderSpec(path="ground_truth", files={"label.json": FileRef(path="ground_truth/label.json")}),
    TextSpec(text="cell"),
], ids=["FileRef", "FolderSpec", "TextSpec"])
def test_the_artifact_leaves_are_frozen(value):
    """A value that travels is a value (CLAUDE.md); a row's slots are never
    edited in place — the layout writes a new example instead."""
    from pydantic import ValidationError

    field = next(iter(type(value).model_fields))
    with pytest.raises(ValidationError):
        setattr(value, field, getattr(value, field))
