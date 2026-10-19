"""Values with identity: one value stored once, referenced as ``<kind>.id.<uuid>``."""

import json

import pytest

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.core.navigation import navigation_map
from flow_sdk.schema.data_spec._kinds import resolve_kind
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.data_spec.value_ref import parse_ref, value_ref
from flow_sdk.values import content_hash, resolve_ref, save_value

ID = "7c1e2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"


def test_a_reference_names_a_kind_and_a_valid_id():
    assert parse_ref(f"navigation.map.id.{ID}") == ("navigation.map", ID)
    assert parse_ref("navigation.map") is None
    assert parse_ref("navigation.map.id.not-a-uuid") is None
    assert parse_ref(f"navigation.map.id.{ID[:14]}7{ID[15:]}") is None  # a v7 id is never adopted
    assert parse_ref(f"id.map.id.{ID}") is None  # "id" is reserved


def test_a_reference_resolves_to_its_kind_s_schema():
    assert resolve_kind(f"navigation.map.id.{ID}") is resolve_kind("navigation.map")


def test_a_field_of_a_kind_takes_the_value_or_a_reference_of_that_kind():
    from pydantic import TypeAdapter, ValidationError

    ref = TypeAdapter(value_ref("navigation.map"))
    assert ref.validate_python(f"navigation.map.id.{ID}")
    with pytest.raises(ValidationError):
        ref.validate_python(f"navigator.target.id.{ID}")


def test_the_same_content_is_stored_once_and_answers_the_same_reference(tmp_path):
    first = save_value(navigation_map(), tmp_path)
    assert save_value(navigation_map(), tmp_path) == first
    folders = [p for p in tmp_path.iterdir() if p.is_dir()]
    assert len(folders) == 1
    doc = json.loads((folders[0] / "value.json").read_text())
    assert doc["spec_kind"] == "navigation.map"
    kind, vid = parse_ref(first)
    assert kind == "navigation.map" and is_valid_entity_id(vid)


def test_changed_content_is_a_new_version(tmp_path):
    first = save_value(navigation_map(), tmp_path)
    older = navigation_map().model_copy(update={"places": navigation_map().places[:3]})
    second = save_value(older, tmp_path)
    assert second != first and len([p for p in tmp_path.iterdir() if p.is_dir()]) == 2


def test_a_reference_reads_back_from_the_store_with_no_database(tmp_path):
    ref = save_value(navigation_map(), tmp_path)
    assert resolve_ref(ref, near=tmp_path) == navigation_map()
    with pytest.raises(LookupError):
        resolve_ref(f"navigation.map.id.{ID}", near=tmp_path)
    with pytest.raises(ValueError):
        resolve_ref("navigation.map", near=tmp_path)


def test_the_content_hash_ignores_key_order_and_the_kind_tag():
    assert content_hash({"a": 1, "b": 2}) == content_hash({"spec_kind": "x", "b": 2, "a": 1})


def test_only_a_value_of_a_registered_kind_can_be_stored(tmp_path):
    class Loose(DataSpec):
        x: int = 1

    with pytest.raises(ValueError):
        save_value(Loose(), tmp_path)
