"""``TypeInfo.asset_spec`` — the shape and the row must agree, and the spec's
field TYPES are the layout: ``Body``/``FreeSection`` markers, sub-assets by registry."""
from __future__ import annotations

from typing import Optional

import pytest
from pydantic import BaseModel

from flow_sdk.builtin.agent import Agent, AgentSpec
from flow_sdk.builtin.dataset import Dataset, DatasetManifestSpec
from flow_sdk.builtin.subagent import SubAgent, SubAgentSpec
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo, check_asset_spec
from flow_sdk.fs_store.serializer.fields import FieldKind, asset_class, field_kinds, field_persistence, spec_layout
from flow_sdk.schema.data_spec import Body, DataSpec, FreeSection, FrontMatter
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(5)


def test_every_spec_bearing_type_passes_the_contract():
    for t in (EntityType.AGENT, EntityType.SUBAGENT, EntityType.DATASET, EntityType.DATA_SOURCE_SPEC, EntityType.SOURCE_ITEM):
        info = SchemaRegistry.get(t)
        assert info.asset_spec is not None, t
        check_asset_spec(str(t), info.entity_cls, info.asset_spec)   # raises on drift
    assert SchemaRegistry.get(EntityType.AGENT).asset_spec is AgentSpec
    assert SchemaRegistry.get(EntityType.SUBAGENT).asset_spec is SubAgentSpec
    assert SchemaRegistry.get(EntityType.DATASET).asset_spec is DatasetManifestSpec


def test_the_entity_may_narrow_but_never_lack_a_spec_field():
    class _Spec(DataSpec):
        skills: list[str] = []
        layout: str = "csv"
        data: Optional[FreeSection] = None

    from flow_sdk.api.type_id import TypeId
    from flow_sdk.schema.data_spec.dataset_spec import DataLayoutEnum

    class _Row(BaseModel):
        type: str = "probe_contract"
        skills: list[TypeId] = []
        layout: DataLayoutEnum = DataLayoutEnum.CSV
        data: Optional[dict] = None

    check_asset_spec("probe_contract", _Row, _Spec)          # str → TypeId / StrEnum narrow; dict aliases agree

    class _Missing(BaseModel):
        type: str = "probe_contract"
        skills: list[str] = []

    with pytest.raises(TypeError, match="'layout' is not a field"):
        check_asset_spec("probe_contract", _Missing, _Spec)


def test_markers_are_field_kinds_and_a_spec_has_at_most_one_of_each():
    assert field_persistence(Body) is FieldKind.BODY
    assert field_persistence(Optional[FreeSection]) is FieldKind.FREE_SECTION
    assert dict(field_kinds(AgentSpec))["system_prompt"] is FieldKind.BODY
    assert dict(field_kinds(DatasetManifestSpec))["data"] is FieldKind.FREE_SECTION
    assert spec_layout(AgentSpec).body == "system_prompt" and spec_layout(AgentSpec).free is None
    assert spec_layout(DatasetManifestSpec).free == "data"

    class _Two(FrontMatter):
        a: Body = ""
        b: Body = ""

    with pytest.raises(TypeError, match="at most one Body"):
        spec_layout(_Two)


def test_sub_assets_are_recognised_by_the_registry_not_inheritance():
    assert asset_class(list[SubAgent]) == (SubAgent, True)
    assert asset_class(Optional[Agent]) == (Agent, False)

    class _Plain(BaseModel):          # a nested value with no registered asset type
        type: str = "probe_unregistered"
        name: str = ""

    assert asset_class(_Plain) == (None, False)
    assert field_persistence(list[_Plain]) is FieldKind.SCALAR

    class _Holder(BaseModel):
        items: list[_Plain] = []

    assert dict(field_kinds(_Holder))["items"] is FieldKind.SCALAR
    # A late registration turns the same field into a sub-asset: the cache is cleared.
    class _PlainSpec(DataSpec):
        name: str = ""

    info = TypeInfo(type_name="probe_unregistered", main_layout="file", asset_spec=_PlainSpec)
    info.entity_cls = _Plain
    SchemaRegistry.register(info)
    assert dict(field_kinds(_Holder))["items"] is FieldKind.SUB_ASSET_LIST


def test_the_body_never_enters_the_shadow_metadata():
    a = Agent(name="a", system_prompt="You are a.")
    assert "system_prompt" not in a.metadata_payload()
    s = SubAgent(name="s", prompt="p")
    assert "prompt" not in s.metadata_payload()
    d = Dataset(name="d", data={"k": 1})
    assert d.metadata_payload().get("data") == {"k": 1}, "the free section stays in the shadow via Persist.TRUE"
