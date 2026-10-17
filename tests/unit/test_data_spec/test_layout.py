"""``DatasetLayout`` — the one thing that knows the disk.

Pinned: ``write_row`` → ``read`` reproduces a row for every leaf type and
for numbered occurrences; sidecars round-trip through ``metadata``; the CSV
layout holds text only; ``write_row_meta`` is byte-identical to what the
graph-workflow capture seam stamps.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.schema.data_spec.dataset_spec import DEFAULT_DATASET_SPEC, RowKind, FileRef, FolderSpec, TextSpec
from flow_sdk.schema.data_spec.layout import CsvLayout, FolderLayout, dataset_layout_for

pytestmark = pytest.mark.timeout(5)  # do not increase without approval

Row = DEFAULT_DATASET_SPEC.row_type()


def test_folder_layout_round_trips_every_leaf_and_numbered_occurrences(tmp_path: Path) -> None:
    row = Row(
        kind=RowKind.EVAL,
        input=FileRef(path="input.pdf"),
        output=[FileRef(path="output-1.txt"), FileRef(path="output-2.txt")],
        ground_truth=FolderSpec(path="ground_truth", files={"grade.json": FileRef(path="ground_truth/grade.json")}),
        metadata={"kind": "eval", "note": 1, "input.json": {"metadata": {"pages": 3}, "data": {"free": True}}},
        data={"x": 1},
    )
    lay = FolderLayout()
    ex_dir = tmp_path / "rows" / "0001"
    lay.write_row(ex_dir, row, contents={"input.pdf": b"%PDF", "ground_truth/grade.json": {"g": 1}})
    assert (ex_dir / "input.pdf").read_bytes() == b"%PDF"
    assert json.loads((ex_dir / "input.json").read_text()) == {"metadata": {"pages": 3}, "data": {"free": True}}

    (back,) = lay.read(tmp_path, Row, dataset_id="ds")
    assert back.model_dump(exclude={"id", "key", "version"}) == row.model_dump(exclude={"id", "key", "version"})
    assert lay.resolve(ex_dir, back.input) == ex_dir / "input.pdf"


def test_folder_layout_skips_a_row_with_no_input_data(tmp_path: Path) -> None:
    d = tmp_path / "rows" / "0001"; d.mkdir(parents=True)
    (d / "input.json").write_text('{"metadata": {}, "data": {}}')   # a sidecar is not data
    (d / "output.txt").write_text("o")
    assert FolderLayout().read(tmp_path, Row, dataset_id="ds") == []


def test_csv_layout_round_trips_text_and_refuses_files(tmp_path: Path) -> None:
    rows = [
        Row(kind=RowKind.TRAIN, input=TextSpec(text="2+2"), ground_truth=TextSpec(text="4"), metadata={"difficulty": "easy"}),
        Row(kind=RowKind.EVAL, input=TextSpec(text="3+3"), ground_truth=TextSpec(text="6"), metadata={"difficulty": "hard"}),
    ]
    lay = CsvLayout()
    lay.write(tmp_path, rows, dataset_id="ds")
    back = lay.read(tmp_path, Row, dataset_id="ds")
    assert [r.model_dump(exclude={"id", "key", "version"}) for r in back] == [r.model_dump(exclude={"id", "key", "version"}) for r in rows]
    with pytest.raises(ValueError, match="text slots only"):
        lay.write(tmp_path, [Row(input=FileRef(path="x.pdf"))], dataset_id="ds")


def test_layout_for_dispatches_on_the_manifest_value() -> None:
    assert isinstance(dataset_layout_for("io_folder"), FolderLayout)
    assert isinstance(dataset_layout_for("csv"), CsvLayout)
    assert isinstance(dataset_layout_for("nonsense"), CsvLayout)       # the walker's default


def test_write_row_meta_is_the_capture_seams_stamp(tmp_path: Path) -> None:
    """``_stamp_row`` and the dataset writer share this one writer."""
    FolderLayout().write_row_meta(tmp_path, {"id": "x", "kind": "train", "source": {"run_id": "r"}})
    assert json.loads((tmp_path / "row.json").read_text()) == {
        "metadata": {"id": "x", "kind": "train", "source": {"run_id": "r"}}, "data": {},
    }
