"""Every declared type states its shape once; ``info.shape`` is the one
declaration every reader asks."""
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


def test_every_walked_declared_type_names_a_carrier() -> None:
    for info in _declared():
        if info.from_disk_fn is not None:
            assert info.identity_carrier is not None, info.type_name


def test_a_declared_folder_type_names_its_main_document() -> None:
    for info in _declared():
        if isinstance(info.shape, Folder) and info.from_disk_fn is not None:
            assert info.shape.main, f"{info.type_name}: a walked folder type must name its main document"


def test_a_folder_shape_takes_its_format_from_its_main_document() -> None:
    assert Folder(main="X.json").ext == ".json"
    assert Folder().ext is None
    assert TypeInfo(type_name="probe_file").shape == File(ext=".md")


def test_declared_editors_survive_the_registry_merge() -> None:
    """An entity class usually registers its type BEFORE the type_info module
    does; the merge must carry the declared editor onto the existing entry."""
    with_editor = {info.type_name: info.editor for info in _declared() if info.editor}
    for type_name, editor in {"markdown": "markdown", "skill": "skill", "subagent": "subagent", "task": "task"}.items():
        assert with_editor.get(type_name) == editor, (type_name, with_editor.get(type_name))
    assert len(with_editor) >= 21, sorted(with_editor)
