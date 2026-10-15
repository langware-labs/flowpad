"""Shared FlowCall declarations apply equally to every execution variant."""
from typing import ClassVar

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core.compute.declared_value import DeclaredShapeError, to_declared
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.confirm_spec import ConfirmSpec
from flow_sdk.schema.data_spec.spec import DataSpec


class ShapeItem(DataSpec):
    spec_kind: ClassVar[str] = "test.flowcall.shapes.item"
    count: int


VARIANTS = [
    ("python", {}),
    ("cli", {"commands": {"linux": "echo 1"}}),
    ("navigate", {}),
    ("prompt", {"prompt": "Return the input"}),
    ("agent", {"agent": "fixture"}),
    ("decision", {"questions": {"matches": {"type": "yes_no", "instructions": "Does it match?"}}}),
    ("ask", {}),
]


@pytest.mark.parametrize("subkind,exe_data", VARIANTS)
def test_all_variants_share_nested_shapes_and_wire_roundtrip(subkind, exe_data):
    shape = {"items": [ShapeItem.spec_kind], "labels": {"*": "enum:new|known"}, "note": "?string"}
    spec = ComputeOpSpec(subkind=subkind, exe_data=exe_data, input=shape, output=shape)
    restored = ComputeOpSpec.model_validate_json(spec.model_dump_json())
    assert restored.input == restored.output_shape == shape
    held = to_declared({"items": [{"count": 2}], "labels": {"first": "new"}}, restored.input)
    assert isinstance(held.items[0], ShapeItem)
    assert held.items[0].count == 2 and held.note is None
    with pytest.raises(DeclaredShapeError):
        to_declared({"items": [{"count": "invalid"}], "labels": {}}, restored.input)


@pytest.mark.parametrize("subkind,exe_data", VARIANTS)
@pytest.mark.parametrize("field", ["input", "output"])
def test_every_variant_rejects_unknown_nested_contract_before_execution(subkind, exe_data, field):
    fields = {"output": "string", field: {"values": [{"*": "?missing.flowcall.contract"}]}}
    with pytest.raises(ValueError, match="unknown declared kind"):
        ComputeOpSpec(subkind=subkind, exe_data=exe_data, **fields)


@pytest.mark.parametrize("shape", [[], ["int", "string"], {"item": 3}, "enum:new|new", "enum:"])
def test_malformed_shapes_are_rejected_by_existing_grammar(shape):
    with pytest.raises(ValueError):
        ComputeOpSpec(subkind="python", exe_data={}, input=shape)


def test_named_values_and_list_references_remain_data_without_resolution():
    ref = f"{ShapeItem.spec_kind}.id.{mint_uuid()}"
    spec = ComputeOpSpec(subkind="python", exe_data={}, input=[ShapeItem.spec_kind], output=ShapeItem)
    assert spec.input == [ShapeItem.spec_kind]
    assert spec.output_shape == ShapeItem.spec_kind
    held = to_declared([ref, {"count": 3}], spec.input)
    assert held[0] == ref and isinstance(held[1], ShapeItem)
    scalar = ComputeOpSpec(subkind="python", exe_data={}, output=ShapeItem,
                           output_spec_kind=ShapeItem.spec_kind)
    assert scalar.output_shape == ShapeItem.spec_kind


@pytest.mark.parametrize("output_field", ["output", "output_spec_kind"])
def test_auto_continue_confirm_uses_effective_output_declaration(output_field):
    spec = ComputeOpSpec(
        subkind="ask", exe_data={"recheck": True, "auto_continue": True},
        completion_check={"commands": {"linux": "true"}},
        **{output_field: ConfirmSpec.spec_kind},
    )
    assert spec.output_shape == ConfirmSpec.spec_kind
    assert spec.exe_data.auto_continue and spec.exe_data.recheck


@pytest.mark.parametrize("output_field", ["output", "output_spec_kind"])
@pytest.mark.parametrize("overrides", [
    {"completion_check": None},
    {"exe_data": {"auto_continue": True}},
    {"shape": "string"},
])
def test_auto_continue_alias_keeps_check_and_confirm_requirements(output_field, overrides):
    kwargs = dict(subkind="ask", exe_data={"recheck": True, "auto_continue": True},
                  completion_check={"commands": {"linux": "true"}})
    changes = dict(overrides)
    kwargs[output_field] = changes.pop("shape", ConfirmSpec.spec_kind)
    kwargs.update(changes)
    with pytest.raises(ValueError, match="auto_continue needs a check"):
        ComputeOpSpec(**kwargs)
