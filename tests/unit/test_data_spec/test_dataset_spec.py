"""``ExampleSpec`` / ``DatasetSpec`` — the typed, generic value models.

Pinned: parametrized validation builds the concrete class; ``O | list[O]``;
gold alone and input alone are legal rows; the bare generic is refused; a named
subclass registers and a parametrization does not; the keyword authoring form
round-trips; a shape held by a ``SpecType`` field dumps compactly.
"""
from __future__ import annotations

import uuid
from typing import Optional

import pytest
from pydantic import BaseModel, ValidationError

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec import DataSpec, to_authoring_form
from flow_sdk.schema.data_spec.dataset_spec import (
    DEFAULT_DATASET_SPEC,
    DatasetSpec,
    ExampleSpec,
    FileRef,
    FolderSpec,
    TextSpec,
)
from flow_sdk.schema.data_spec.layout import example_id

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


class _Email(DataSpec):
    subject: str
    body: str


class _Label(DataSpec):
    category: str


Row = ExampleSpec[_Email, _Label, DataSpec]


def test_a_parametrization_validates_rows_as_the_concrete_classes() -> None:
    ds = DatasetSpec[Row].model_validate({"examples": [
        {"input": {"subject": "s", "body": "b"}, "output": {"category": "invoice"}},
    ]})
    ex = ds.examples[0]
    assert type(ex) is Row
    assert type(ex.input) is _Email and type(ex.output) is _Label
    with pytest.raises(ValidationError):
        DatasetSpec[Row].model_validate({"examples": [{"input": {"subject": "s"}}]})


def test_output_is_one_or_many() -> None:
    one = Row.model_validate({"input": {"subject": "s", "body": "b"}, "output": {"category": "a"}})
    many = Row.model_validate({"input": {"subject": "s", "body": "b"},
                               "output": [{"category": "a"}, {"category": "b"}]})
    assert type(one.output) is _Label
    assert [o.category for o in many.output] == ["a", "b"]


def test_gold_alone_and_input_alone_are_legal_rows() -> None:
    """Hand-authored (gold only), captured (output only), unlabeled (neither)."""
    base = {"input": {"subject": "s", "body": "b"}}
    assert Row.model_validate({**base, "ground_truth": {"category": "a"}}).output is None
    assert Row.model_validate(base).ground_truth is None


def test_the_bare_generic_is_refused() -> None:
    """Unparametrized, Pydantic would silently validate against the BOUNDS."""
    with pytest.raises(TypeError, match="generic"):
        ExampleSpec.model_validate({"input": {"path": "x"}})
    with pytest.raises(TypeError, match="generic"):
        DatasetSpec.model_validate({"examples": []})


def test_a_named_subclass_registers_and_a_parametrization_does_not() -> None:
    class Triage(Row):
        spec_kind = "test.triage"
    try:
        assert SchemaRegistry.kind_type("test.triage") is Triage
        assert SchemaRegistry.kind_for(Row) is None            # inherits the origin's kind — must not register
        assert SchemaRegistry.kind_for(DatasetSpec[Triage]) is None
    finally:
        SchemaRegistry._kinds.pop("test.triage", None)


def test_the_leaves_are_registered_kinds() -> None:
    assert DataSpec.parse("file_ref") is FileRef
    assert DataSpec.parse("folder") is FolderSpec
    assert DataSpec.parse("text") is TextSpec


def test_the_default_spec_accepts_any_artifact_per_slot() -> None:
    ex = DEFAULT_DATASET_SPEC.example_type().model_validate({
        "input": {"path": "in.pdf"},
        "output": {"path": "out", "files": {"a.txt": {"path": "out/a.txt"}}},
        "ground_truth": {"text": "4"},
    })
    assert (type(ex.input), type(ex.output), type(ex.ground_truth)) == (FileRef, FolderSpec, TextSpec)


@pytest.mark.parametrize("form", [
    {"examples": [{"input": "file_ref", "output": "file_ref"}]},
    {"examples": [{"input": {"subject": "string", "body": "string"}, "output": {"category": "string"}}]},
    {"examples": [{"input": "text", "output": "text", "context": {"history": ["string"]}}]},
    {"examples": [{"input": "text"}]},
])
def test_the_keyword_authoring_form_round_trips(form) -> None:
    t = DatasetSpec.parse(form)
    assert to_authoring_form(t) == form          # the ONE serializer knows the keyword form
    assert DatasetSpec.parse(form) is t                      # cached per canonical form


def test_the_authoring_form_is_strict() -> None:
    for bad in ({"rows": []}, {"examples": []}, {"examples": [{}, {}]}, {"examples": [{"output": "text"}]},
                {"examples": [{"input": "text", "extra": "text"}]},
                {"examples": [{"input": "text", "output": "text", "ground_truth": "file_ref"}]}):
        with pytest.raises(ValueError):
            DatasetSpec.parse(bad)


def test_a_dataset_shape_held_by_a_field_dumps_compactly_and_is_strict() -> None:
    """The FIELD is strict: a malformed spec on an API write is an error, not a
    silent None. Leniency is a disk-read policy — see ``test_a_malformed_spec_on_disk``."""
    from flow_sdk.builtin.dataset import DatasetSpecType

    class Holder(BaseModel):
        spec: Optional[DatasetSpecType] = None
    form = {"examples": [{"input": {"subject": "string", "body": "string"}, "output": "text"}]}
    h = Holder(spec=form)
    assert h.model_dump(mode="json")["spec"] == form
    assert Holder().model_dump(mode="json")["spec"] is None
    with pytest.raises(ValidationError):
        Holder(spec="garbage!!")


def test_a_malformed_spec_on_disk_degrades_the_slot_not_the_dataset(tmp_path) -> None:
    """``from_fs`` reads the header leniently: a bad ``spec`` in ``dataset.json``
    is logged and dropped, and the rows beside it still load."""
    import json

    from flow_sdk.builtin.dataset import Dataset
    (tmp_path / "dataset.json").write_text(json.dumps({
        "metadata": {"data_layout": "csv", "spec": {"examples": [{"input": "Not A Kind!"}]}}, "data": {}}))
    (tmp_path / "data.csv").write_text("input,expected\n2+2,4\n")
    from flow_sdk.fs_store.origin.local_origin import local_origin_for_path
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    ds = SchemaRegistry.get("dataset").serializer().load(Dataset, local_origin_for_path(tmp_path))
    assert ds.spec is None and len(ds.examples) == 1


def test_layout_property_reads_example_json_metadata() -> None:
    ex = DEFAULT_DATASET_SPEC.example_type().model_validate({"input": {"text": "x"}, "metadata": {"layout": "pages"}})
    assert ex.layout == "pages"


def test_example_id_formula_is_unchanged() -> None:
    """Pinned: three grammar tests hard-code this; it is a data-migration boundary."""
    assert example_id("ds-x", "0001") == str(uuid.uuid5(uuid.NAMESPACE_DNS, "ds-x:0001"))
