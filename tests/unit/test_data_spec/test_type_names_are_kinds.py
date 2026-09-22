"""A type name IS a kind, and a kind always names a shape.

Before this, the two registries disagreed. ``SchemaRegistry._kinds`` held
whatever a class declared; ``._types`` held the entity types; and a type name
resolved through a fallback to the ENTITY class. So the same authoring form
meant two different things — ``"output": "compute_op"`` gave a document shape
(that spec declared a ``spec_kind``), ``"output": "task"`` gave a database row
model — and a ``SpecType`` field holding the latter could not validate anything,
because a row demands ids and DB columns a value has never heard of.

Now an asset spec is registered under its own type name, derived, and the
fallback is gone.
"""
from __future__ import annotations

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec import DataSpec

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


def _asset_specs() -> dict:
    SchemaRegistry._ensure_loaded()
    return {
        name: info.asset_spec
        for name in SchemaRegistry.get_all_types()
        if (info := SchemaRegistry.get(name)) is not None and info.asset_spec is not None
    }


def test_every_asset_type_is_nameable_by_its_own_type_name() -> None:
    """16 of 20 declared no kind at all and were reachable only as a row class."""
    for name, spec in _asset_specs().items():
        assert DataSpec.parse(name) is spec, f"{name!r} does not resolve to {spec.__name__}"


def test_a_declared_kind_survives_as_an_alias() -> None:
    """Three specs name themselves something other than their type. Both spellings
    resolve, so nothing already written to disk has to be migrated."""
    for declared, type_name in (
        ("ingest.source_item", "source_item"),
        ("mcp.server", "mcp"),
        ("project.manifest", "project_manifest"),
    ):
        assert DataSpec.parse(declared) is DataSpec.parse(type_name)


def test_the_declared_name_stays_the_one_that_is_WRITTEN() -> None:
    """The inverse is what serializes. Deriving the forward mapping must not
    change a single byte of what a dump emits."""
    specs = _asset_specs()
    assert SchemaRegistry.kind_for(specs["source_item"]) == "ingest.source_item"
    assert SchemaRegistry.kind_for(specs["mcp"]) == "mcp.server"
    assert SchemaRegistry.kind_for(specs["project_manifest"]) == "project.manifest"
    # …and a spec that declared nothing now HAS an inverse, where it had none:
    # without one, ``to_authoring_form`` walked its fields and raised.
    assert SchemaRegistry.kind_for(specs["compute_op"]) == "compute_op"


def test_an_inherited_spec_kind_does_not_steal_its_parent_s_name() -> None:
    """``FileDataPage`` inherits ``source.page`` from ``DataPage`` and declares
    nothing of its own. It used to register anyway, so the name resolved to the
    narrower subclass and a plain page no longer validated against its own kind."""
    from flow_sdk.sources.values.page import DataPage, FileDataPage

    assert "spec_kind" not in FileDataPage.__dict__
    assert DataSpec.parse("source.page") is DataPage


def test_a_kind_names_exactly_one_shape() -> None:
    """Rebinding used to be silent: whichever class the process imported second
    won, and nothing anywhere said so."""
    other = DataSpec.parse({"a": "int"})
    with pytest.raises(ValueError, match="already bound"):
        SchemaRegistry.register_kind("compute_op", other)


def test_the_only_kind_that_is_not_a_DataSpec_is_fs_ref() -> None:
    """A kind names a shape. In practice that means a ``DataSpec``, and the one
    SDK-registered exception is ``fs_ref`` → ``FSRef``, a plain value class
    pydantic can still validate (a capability's discovered value takes that
    shape). It is an exception, not a door: this pins the set so a second one
    cannot arrive unnoticed, and so nobody re-opens the Entity-class path that
    made ``"output": "task"`` hand a `SpecType` field a database row."""
    SchemaRegistry._ensure_loaded()
    strays = {
        kind
        for kind, shape in SchemaRegistry._kinds.items()
        if isinstance(shape, type) and not issubclass(shape, DataSpec)
    }
    assert strays == {"fs_ref"}, f"unexpected non-DataSpec kinds: {sorted(strays - {'fs_ref'})}"
