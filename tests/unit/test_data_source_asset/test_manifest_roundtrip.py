"""A ``DataSourceSpec`` is a folder asset whose main doc is the FLAT manifest:
the header is the whole document, under the file's own keys."""
from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.data_source_spec import AuthSpec, ConfigFieldSpec, DataSourceSpec, ManifestSpec
from flow_sdk.fs_store.origin.local_origin import local_origin_for_path
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(5)


def test_store_writes_a_flat_manifest_and_load_reads_it_back(tmp_path):
    ser = SchemaRegistry.get(EntityType.DATA_SOURCE_SPEC).serializer()
    spec = DataSourceSpec(
        name="wiki", title="Wiki", description="d", icon_name="Book", setup_wiki="setup",
        requires={"flow_sdk": ">=0.2"}, auth=AuthSpec(connector="google", scopes=["s"]),
        reflect=["none", "copy"],
        config={"root": ConfigFieldSpec(type="path", required=True, label="Root", pattern="^/")},
    )
    root = tmp_path / "wiki"
    ser.store(spec, local_origin_for_path(root))

    doc = json.loads((root / "data_source.json").read_text())
    assert "metadata" not in doc, "no data_field ⇒ the header IS the document"
    assert doc["schema"] == 1 and "manifest_schema" not in doc, "the file keeps its own key"
    assert doc["config"]["root"]["type"] == "path"
    assert "runtime" not in doc, "derived from the folder, never authored"

    back = ser.load(DataSourceSpec, local_origin_for_path(root))
    for name in ManifestSpec.model_fields:
        assert getattr(back, name) == getattr(spec, name), name
