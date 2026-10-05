"""A dataset whose rows are TYPED values, named by a registered kind -- written, annotated, read back.

Three reads that used to fail, each proven by an on/off lever before it was fixed:

* a NAMED dataset kind (``class D(DatasetSpec[E]): spec_kind = ...``) answered no slot types,
  because pydantic keeps the generic args on the parametrized BASE, not on the subclass;
* a list of acceptable gold answers, written as ``ground_truth-1/``, ``ground_truth-2/``, was
  never loaded typed -- only the bare ``ground_truth/`` folder was;
* a gold label written by ``annotate`` (``ground_truth/label.json``) was never loaded typed --
  only the walker's own main document (``ground_truth/<kind>.json``) was.
"""

from __future__ import annotations

from typing import ClassVar, Literal, Optional

import pytest

from flow_sdk.schema.data_spec.dataset_spec import DatasetSpec, ExampleKind, ExampleSpec
from flow_sdk.schema.data_spec.layout import FolderLayout
from flow_sdk.schema.data_spec.spec import DataSpec

pytestmark = pytest.mark.timeout(5)


class Ask(DataSpec):
    spec_kind: ClassVar[str] = "unittest.typedrows.ask"
    utterance: str


class Verdict(DataSpec):
    spec_kind: ClassVar[str] = "unittest.typedrows.verdict"
    route: Literal["quick", "agentic"]
    target: Optional[str] = None


Row = ExampleSpec[Ask, Verdict, DataSpec]


class Rows(DatasetSpec[Row]):
    spec_kind: ClassVar[str] = "unittest.typedrows.dataset"


def test_a_named_dataset_kind_keeps_its_slot_types():
    assert Rows.example_type() is Row
    assert (Row.input_type(), Row.output_type()) == (Ask, Verdict)


def test_the_dataset_entity_reads_its_shapes_from_the_kind_name():
    from flow_sdk.builtin.dataset import Dataset

    d = Dataset(name="x", data_layout="io_folder", spec="unittest.typedrows.dataset")
    assert (d.input_shape, d.output_shape) == (Ask, Verdict)


def test_a_list_of_gold_answers_reads_back_typed(tmp_path):
    golds = [Verdict(route="quick", target="view:preferences"), Verdict(route="quick", target="view:settings")]
    FolderLayout().append_many(
        tmp_path,
        [(Row(kind=ExampleKind.EVAL, input=Ask(utterance="settings"), ground_truth=golds), None)],
        dataset_id="ds",
    )
    assert (tmp_path / "examples/0001/ground_truth-2/verdict.json").is_file()
    (back,) = FolderLayout().read(tmp_path, Row, dataset_id="ds")
    assert back.ground_truth == golds


def test_an_annotated_gold_reads_back_typed(tmp_path):
    (eid,) = FolderLayout().append_many(tmp_path, [(Row(input=Ask(utterance="summarize it")), None)], dataset_id="ds")
    FolderLayout().annotate(tmp_path, eid, {"route": "agentic"}, dataset_id="ds", by="me")
    assert (tmp_path / "examples/0001/ground_truth/label.json").is_file()
    (back,) = FolderLayout().read(tmp_path, Row, dataset_id="ds")
    assert back.ground_truth == Verdict(route="agentic")
