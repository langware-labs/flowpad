"""``DataSpec`` — the base of every shape.

What is pinned is the contract: the authoring form has no keywords and
round-trips through ``parse``/``to_authoring_form``; a dict is ALWAYS an
object; a parsed shape is a real Pydantic class whose validation, errors and
JSON Schema are Pydantic's own; a named subclass registers under its kind and
a parametrization does not; ``ShapeForm`` carries a declared shape as data.
"""
from __future__ import annotations

from typing import Any, Optional

import pytest
from pydantic import BaseModel, ValidationError

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec import DataSpec, to_authoring_form
from flow_sdk.schema.data_spec._form import ShapeForm, compile_form
from flow_sdk.schema.data_spec._kinds import PRIMITIVES

pytestmark = pytest.mark.timeout(5)  # do not increase without approval

FORMS: list[Any] = [
    "string",
    {"category": "string", "score": "float"},
    ["string"],
    {"rows": [{"a": "int"}], "ok": "bool"},
    # the registration hook is `spec_kind`, so `kind` is an ordinary field name
    {"kind": "string", "fields": "int", "item": "bool"},
]


@pytest.mark.parametrize("form", FORMS)
def test_authoring_form_round_trips(form: Any) -> None:
    assert to_authoring_form(DataSpec.parse(form)) == form


def test_a_dict_is_always_an_object() -> None:
    """``{"kind": "int"}`` is a one-field object whose field is called ``kind``."""
    cls = DataSpec.parse({"kind": "int"})
    assert issubclass(cls, DataSpec)
    assert list(cls.model_fields) == ["kind"]
    assert cls.model_validate({"kind": 3}).kind == 3


def test_parse_is_idempotent_on_a_type() -> None:
    cls = DataSpec.parse({"a": "int"})
    assert DataSpec.parse(cls) is cls
    assert DataSpec.parse(str) is str


def test_identical_object_shapes_share_one_class() -> None:
    assert DataSpec.parse({"x": "int"}) is DataSpec.parse({"x": "int"})


def test_kind_is_adopted_through_the_tag_grammar() -> None:
    assert to_authoring_form(DataSpec.parse({"x": "  String  "})) == {"x": "string"}
    for bad in ("Not A Kind!", "a..b", ""):
        with pytest.raises(ValueError):
            DataSpec.parse({"x": bad})


def test_a_list_shape_carries_exactly_one_element() -> None:
    for bad in (["a", "b"], []):
        with pytest.raises(ValueError, match="exactly one element"):
            DataSpec.parse(bad)


# ── compiled classes are Pydantic's ───────────────────────────────────────────

def test_validation_is_pydantics_with_a_path_per_leaf() -> None:
    cls = DataSpec.parse({"category": "string", "tags": ["string"], "n": "int"})
    ok = cls.model_validate({"category": "x", "tags": ["a", "b"], "n": 3})
    assert (ok.category, ok.tags, ok.n) == ("x", ["a", "b"], 3)
    with pytest.raises(ValidationError) as exc:
        cls.model_validate({"category": 1, "tags": "no", "n": "z"})
    assert {tuple(e["loc"]) for e in exc.value.errors()} == {("category",), ("tags",), ("n",)}


def test_every_declared_field_is_required_and_extras_are_forbidden() -> None:
    cls = DataSpec.parse({"a": "int"})
    with pytest.raises(ValidationError):
        cls.model_validate({})
    with pytest.raises(ValidationError):
        cls.model_validate({"a": 1, "b": 2})


def test_json_schema_is_pydantics() -> None:
    schema = DataSpec.parse({"category": "string", "tags": ["int"]}).model_json_schema()
    assert schema["properties"]["category"] == {"title": "Category", "type": "string"}
    assert schema["properties"]["tags"]["items"] == {"type": "integer"}
    assert schema["required"] == ["category", "tags"]
    assert schema["additionalProperties"] is False


@pytest.mark.parametrize("kind,py", list(PRIMITIVES.items()))
def test_primitives_resolve_to_python_types(kind: str, py: type) -> None:
    assert DataSpec.parse(kind) is py
    assert to_authoring_form(py) == kind


def test_an_anonymous_kind_is_legal_and_opaque() -> None:
    """Unregistered ⇒ ``Any``: never minted, never an error."""
    cls = DataSpec.parse({"scan": "content.file"})
    assert cls.model_validate({"scan": "in/a.pdf"}).scan == "in/a.pdf"
    assert cls.model_validate({"scan": 42}).scan == 42


# ── registration ──────────────────────────────────────────────────────────────

def test_a_named_subclass_registers_and_forms_to_its_kind() -> None:
    class Point(DataSpec):
        spec_kind = "test.point"
        x: int
        y: int
    try:
        assert SchemaRegistry.kind_type("test.point") is Point
        assert DataSpec.parse("test.point") is Point
        assert to_authoring_form(Point) == "test.point"
        holder = DataSpec.parse({"at": "test.point"})
        assert holder.model_validate({"at": {"x": 1, "y": 2}}).at.y == 2
        with pytest.raises(ValidationError):
            holder.model_validate({"at": {"x": "no", "y": 2}})
    finally:
        SchemaRegistry._kinds.pop("test.point", None)


def test_an_unnamed_subclass_does_not_register_and_forms_to_its_fields() -> None:
    class Anon(DataSpec):
        a: int
    assert SchemaRegistry.kind_for(Anon) is None
    assert to_authoring_form(Anon) == {"a": "int"}


def test_spec_kind_as_a_field_trips_the_guard() -> None:
    with pytest.raises(AssertionError, match="ClassVar"):
        class Bad(DataSpec):  # noqa: F841
            spec_kind: str = "x"   # annotated ⇒ a field ⇒ refused


def test_an_entity_type_name_names_that_type_s_DOCUMENT_SHAPE() -> None:
    """One namespace, one meaning: a kind always names a ``DataSpec``.

    It used to resolve to the Entity class, so ``"output": "dataset"`` handed a
    ``ShapeForm`` field a row model — which cannot validate a value, because it
    demands ids and DB columns the value has never heard of. Meanwhile
    ``"output": "compute_op"`` gave a document shape, purely because that one
    spec declared a ``spec_kind``. Same syntax, two meanings.
    """
    from flow_sdk.builtin.dataset import Dataset  # noqa: F401 — binds the type
    from flow_sdk.schema.data_spec.dataset_manifest_spec import DatasetManifestSpec

    assert SchemaRegistry.kind_type("dataset") is DatasetManifestSpec


def test_a_row_only_type_name_is_an_error_not_a_silent_any() -> None:
    """A registered type with no asset document names no shape. The author meant
    a real thing; answering ``Any`` would hand them an untyped field instead."""
    import flow_sdk.builtin.conversation  # noqa: F401 — binds the type

    with pytest.raises(ValueError, match="no document shape"):
        DataSpec.parse("conversation")


def test_an_unregistered_name_is_still_anonymous() -> None:
    """The forward-reference path eager compilation depends on: a name nobody
    has registered is opaque, not an error."""
    assert DataSpec.parse({"x": "nobody.registered.this"}).model_fields["x"].annotation is Any


def test_a_primitive_cannot_be_registered() -> None:
    with pytest.raises(ValueError, match="reserved primitive"):
        SchemaRegistry.register_kind("string", DataSpec.parse({"a": "int"}))


def test_a_kind_referenced_before_registration_is_anonymous() -> None:
    """Eager compilation: a self-reference resolves to ``Any`` — there is no
    cycle to detect, and nothing is minted."""
    cls = DataSpec.parse({"children": ["test.not.yet"]})
    assert cls.model_validate({"children": [1, "x", None]}).children == [1, "x", None]


# ── ShapeForm: a declared shape, held as DATA ────────────────────────────────

def test_a_declared_shape_is_held_as_the_form_and_dumps_unchanged() -> None:
    """``SpecType`` held a live CLASS in a field — the one place a spec carried
    something that is not data, which is why it needed a custom serializer to
    survive JSON at all. ``ShapeForm`` keeps the form; a caller that needs a
    class calls ``compile_form``."""
    class Holder(BaseModel):
        shape: Optional[ShapeForm] = None

    for form in FORMS:
        h = Holder(shape=form)
        assert h.shape == form                     # the FIELD is the form
        assert h.model_dump(mode="json")["shape"] == form
        assert Holder.model_validate(h.model_dump(mode="json")).shape == h.shape
        assert compile_form(h.shape) == DataSpec.parse(form)   # a parametrized generic is not interned
    assert Holder().model_dump(mode="json")["shape"] is None
    assert Holder(shape=str).shape == "string"     # a type is rendered to its form


def test_a_kind_miss_asks_the_loader_that_owns_its_namespace(monkeypatch) -> None:
    """A kind defined by lazily loaded code (a data source asset's value class) resolves on first
    read; a miss outside the loader's prefix never runs it."""
    calls: list[str] = []

    def loader() -> None:
        calls.append("ran")
        SchemaRegistry.register_kind("test.lazy.loaded", DataSpec.parse({"a": "int"}))

    monkeypatch.setattr(SchemaRegistry, "_kind_loaders", [("test.lazy.", loader)])
    assert SchemaRegistry.kind_type("other.namespace.kind") is None and calls == []
    assert SchemaRegistry.kind_type("test.lazy.loaded") is not None and calls == ["ran"]
