"""Per-example writes on the io_folder layout: ``append`` numbers after the
highest dir and returns the pinned id; ``annotate`` writes ``ground_truth/label.json``
+ provenance; CSV refuses both explicitly."""
from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.dataset import ARTIFACT_ROW
from flow_sdk.schema.data_spec.dataset_spec import DataLayoutEnum, ExampleKind, FileRef, FolderSpec
from flow_sdk.schema.data_spec.layout import CsvLayout, FolderLayout, example_id, layout_for

pytestmark = pytest.mark.timeout(5)

DS = "11111111-1111-4111-8111-111111111111"


def _row():
    return ARTIFACT_ROW(kind=ExampleKind.TRAIN,
                        input=FolderSpec(path="input", files={"item.json": FileRef(path="input/item.json")}),
                        metadata={"source": {"item_id": "x"}})


def test_append_numbers_after_the_highest_and_returns_the_pinned_id(tmp_path):
    lay = FolderLayout()
    first = lay.append(tmp_path, _row(), dataset_id=DS, contents={"input/item.json": {"name": "a"}})
    (tmp_path / "examples" / "0007").mkdir()          # a gap: numbering follows the max, not the count
    third = lay.append(tmp_path, _row(), dataset_id=DS, contents={"input/item.json": {"name": "b"}})
    assert first == example_id(DS, "0001") and third == example_id(DS, "0008")
    assert json.loads((tmp_path / "examples" / "0008" / "input" / "item.json").read_text()) == {"name": "b"}
    rows = lay.read(tmp_path, ARTIFACT_ROW, dataset_id=DS)
    assert [r.id for r in rows] == [first, third] and rows[0].ground_truth is None


def test_annotate_writes_gold_and_provenance_and_the_reader_counts_it(tmp_path):
    lay = FolderLayout()
    eid = lay.append(tmp_path, _row(), dataset_id=DS, contents={"input/item.json": {"name": "a"}})
    ex_dir = lay.annotate(tmp_path, eid, {"sentiment": "positive"}, dataset_id=DS, by="user-1")
    assert json.loads((ex_dir / "ground_truth" / "label.json").read_text()) == {"sentiment": "positive"}
    meta = json.loads((ex_dir / "example.json").read_text())["metadata"]
    assert meta["annotations"][0]["by"] == "user-1" and meta["source"] == {"item_id": "x"}, "provenance kept"
    [row] = lay.read(tmp_path, ARTIFACT_ROW, dataset_id=DS)
    assert isinstance(row.ground_truth, FolderSpec) and "label.json" in row.ground_truth.files
    with pytest.raises(LookupError):
        lay.annotate(tmp_path, example_id(DS, "9999"), {}, dataset_id=DS)


def test_csv_refuses_per_example_writes(tmp_path):
    lay = layout_for(DataLayoutEnum.CSV)
    assert isinstance(lay, CsvLayout)
    with pytest.raises(NotImplementedError):
        lay.append(tmp_path, _row(), dataset_id=DS)
    with pytest.raises(NotImplementedError):
        lay.annotate(tmp_path, "x", {}, dataset_id=DS)
