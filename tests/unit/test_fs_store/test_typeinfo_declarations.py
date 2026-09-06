"""Every declared type states its shape once; the layout fields are
read-only projections of it."""
from __future__ import annotations

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo
from flow_sdk.schema.layout import File, Folder
from flow_sdk.schema.type_info import register_all


@pytest.fixture(scope="module", autouse=True)
def _registry() -> None:
    register_all()
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401


def _declared() -> list[TypeInfo]:
    return [info for info in map(SchemaRegistry.get, SchemaRegistry.get_all_types()) if info.declared]


def test_every_declared_type_has_a_shape() -> None:
    assert _declared(), "register_all marks declared types"
    for info in _declared():
        assert isinstance(info.shape, (File, Folder)), info.type_name


def test_legacy_layout_fields_are_projections_of_the_shape() -> None:
    for info in _declared():
        if isinstance(info.shape, Folder):
            assert info.main_layout == "folder" and info.main_file == info.shape.main, info.type_name
            assert info.folder_backed, info.type_name
            if info.shape.main:
                assert info.main_ext == "." + info.shape.main.rsplit(".", 1)[-1].lower(), info.type_name
        else:
            assert info.main_layout == "file" and info.main_file is None, info.type_name
            assert info.main_ext == info.shape.ext, info.type_name


def test_every_walked_declared_type_names_a_carrier() -> None:
    for info in _declared():
        if info.from_disk_fn is not None:
            assert info.identity_carrier is not None, info.type_name


def test_a_declared_folder_type_names_its_main_document() -> None:
    for info in _declared():
        if isinstance(info.shape, Folder) and info.from_disk_fn is not None:
            assert info.shape.main, f"{info.type_name}: a walked folder type must name its main document"


def test_the_layout_fields_project_the_shape() -> None:
    probe = TypeInfo(type_name="probe_shape", shape=Folder(main="X.json"))
    assert (probe.main_layout, probe.main_file, probe.folder_backed, probe.main_ext) == ("folder", "X.json", True, ".json")
    assert TypeInfo(type_name="probe_file").shape == File(ext=".md")


def test_declared_editors_survive_the_registry_merge() -> None:
    """An entity class usually registers its type BEFORE the type_info module
    does; the merge must carry the declared editor onto the existing entry."""
    with_editor = {info.type_name: info.editor for info in _declared() if info.editor}
    for type_name, editor in {"markdown": "markdown", "skill": "skill", "subagent": "subagent", "task": "task"}.items():
        assert with_editor.get(type_name) == editor, (type_name, with_editor.get(type_name))
    assert len(with_editor) >= 21, sorted(with_editor)
