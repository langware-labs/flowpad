"""Asset-hosted editors: the folder convention, the type's builtin list, and
the resolution an entity's ``editor`` action performs."""
from __future__ import annotations

import pytest

from flow_sdk.assets.asset_editors import BUILTIN_EDITORS_ROOT, asset_editor_root, list_asset_editors
from flow_sdk.builtin.data_source_spec import DataSourceSpec
from flow_sdk.fs_store.origin.local_origin import local_origin_for_path
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(5)


def _spec_folder(tmp_path, *, editors=()):
    root = tmp_path / "wiki"
    ser = SchemaRegistry.get(EntityType.DATA_SOURCE_SPEC).serializer()
    ser.store(DataSourceSpec(name="wiki", title="Wiki"), local_origin_for_path(root))
    for name in editors:
        (root / "editors" / name).mkdir(parents=True)
        (root / "editors" / name / "index.html").write_text("<html></html>")
    return root, ser


def test_builtin_spec_editor_ships_with_the_sdk():
    assert (BUILTIN_EDITORS_ROOT / "spec" / "index.html").is_file()
    assert "spec" in SchemaRegistry.get(EntityType.DATA_SOURCE_SPEC).editors


def test_list_is_what_the_folder_ships_and_ignores_bad_names(tmp_path):
    root, _ = _spec_folder(tmp_path, editors=("curate", "bad name"))
    assert list_asset_editors(root) == ["curate"]
    assert list_asset_editors(tmp_path / "nothing") == [], "no editors/ dir costs one stat"


def test_load_derives_shipped_editors_on_the_row(tmp_path):
    root, ser = _spec_folder(tmp_path, editors=("curate",))
    spec = ser.load(DataSourceSpec, local_origin_for_path(root))
    assert spec.editors == ["curate"], "builtins stay on the type, not the row"


def test_resolution_prefers_the_asset_then_the_builtin(tmp_path):
    root, ser = _spec_folder(tmp_path, editors=("curate",))
    spec = ser.load(DataSourceSpec, local_origin_for_path(root))
    spec.asset_ref = str(root)
    assert asset_editor_root(spec, "curate") == root / "editors" / "curate"
    assert asset_editor_root(spec, "spec") == BUILTIN_EDITORS_ROOT / "spec"
    assert asset_editor_root(spec, "missing") is None
    assert asset_editor_root(spec, "../spec") is None
