"""The ENTITY DOCUMENT: a folder entity's fields live in ``<type>.json``, rendered and read in one place.

``<type>.json`` holds ``type``, ``id``, ``name`` and every header field the spec declares — the shape of
the record shadow ``metadata.json`` — and each ``Body`` lives beside it as ``<field>.md``. Pinned on a toy
type so the mechanism is proven apart from any one entity.
"""
from __future__ import annotations

import json
import uuid
from typing import Optional

import pytest
from pydantic import BaseModel, ConfigDict

from flow_sdk.assets.identity_carrier import ABSENT, Found, JsonRoot, Sidecar, dump_json_document
from flow_sdk.assets.layout import Folder
from flow_sdk.assets.serialization import read_asset_data, write_asset_tree
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.schema_registry import ENTITY_LAYOUT, TypeInfo, check_entity_layout
from flow_sdk.schema.data_spec import Body, DataSpec

pytestmark = pytest.mark.timeout(5)  # do not increase without approval

TYPE = "note_probe"


class _NoteSpec(DataSpec):
    model_config = ConfigDict(extra="ignore")

    title: Optional[str] = None
    tags: list[str] = []
    text: Body = ""


class _Note(BaseModel):
    id: str = ""
    name: str = ""
    title: Optional[str] = None
    tags: list[str] = []
    text: str = ""


INFO = TypeInfo(
    type_name=TYPE, shape=Folder.entity_json(TYPE), asset_spec=_NoteSpec,
    manifest_layout=ENTITY_LAYOUT, name_from_path=True, owns_main_ref=True,
)


def _note(**fields) -> _Note:
    return _Note(**{"id": str(uuid.uuid4()), "name": "hello", "title": "Hi", "tags": ["a"], "text": "The body.\n\nSecond line.", **fields})


def _write(tmp_path, note: _Note):
    root = tmp_path / note.name
    write_asset_tree(note, INFO, root)
    return root


def test_the_fields_live_in_type_json_in_the_shadow_order_and_the_body_beside_it(tmp_path):
    note = _note()
    root = _write(tmp_path, note)
    doc = json.loads((root / f"{TYPE}.json").read_text())
    assert list(doc) == ["type", "id", "name", "title", "tags"]
    assert (doc["type"], doc["id"], doc["name"]) == (TYPE, note.id, "hello")
    assert "text" not in doc
    assert (root / "text.md").read_text() == "The body.\n\nSecond line.\n"


def test_a_document_reads_back_into_the_same_fields(tmp_path):
    note = _note()
    record = read_asset_data(_write(tmp_path, note), INFO)
    assert (record.id, record.name, record.title, record.tags, record.text) == (note.id, "hello", "Hi", ["a"], "The body.\n\nSecond line.")


def test_an_owned_rerender_keeps_the_id_and_the_authored_version(tmp_path):
    note = _note()
    root = _write(tmp_path, note)
    main = root / f"{TYPE}.json"
    main.write_text(json.dumps({**json.loads(main.read_text()), "version": 3}))
    write_asset_tree(note.model_copy(update={"title": "Changed"}), INFO, root)
    doc = json.loads(main.read_text())
    assert (doc["id"], doc["version"], doc["title"]) == (note.id, 3, "Changed")
    assert list(doc)[:4] == ["type", "id", "name", "version"]


def test_an_empty_body_is_still_a_file(tmp_path):
    root = _write(tmp_path, _note(text=""))
    assert (root / "text.md").read_text() == ""
    assert read_asset_data(root, INFO).text == ""


def test_a_document_naming_another_type_is_refused(tmp_path):
    root = _write(tmp_path, _note())
    main = root / f"{TYPE}.json"
    main.write_text(json.dumps({**json.loads(main.read_text()), "type": "agent"}))
    with pytest.raises(ValueError, match="not a 'note_probe'"):
        read_asset_data(root, INFO)


def test_editing_the_body_file_alone_makes_the_asset_stale(tmp_path, monkeypatch):
    monkeypatch.setattr("flow_sdk.fs_store.schema_registry.SchemaRegistry.get", classmethod(lambda cls, name: INFO))
    root = _write(tmp_path, _note())
    before = INFO.asset_hash_fn(FSRef(root))
    (root / "text.md").write_text("A different, longer body than before.\n")
    assert INFO.asset_hash_fn(FSRef(root)) != before


def test_the_json_root_carrier_reads_a_missing_document_as_absent_and_stamps_after_the_type(tmp_path):
    carrier = JsonRoot()
    assert carrier.read(tmp_path / "missing.json") is ABSENT
    doc = tmp_path / "x.json"
    doc.write_text(json.dumps({"type": TYPE, "name": "x"}))
    entity_id = str(uuid.uuid4())
    assert carrier.stamp(doc, entity_id) == entity_id
    assert list(json.loads(doc.read_text())) == ["type", "id", "name"]
    assert carrier.read(doc) == Found(entity_id)
    assert dump_json_document({"name": "report", "id": "1"}) == '{\n  "name": "report",\n  "id": "1"\n}\n'


def test_the_entity_layout_defaults_its_carrier_and_is_checked_at_registration():
    assert isinstance(INFO.identity_carrier, JsonRoot) and INFO.body_file == "text"
    check_entity_layout(INFO)
    with pytest.raises(TypeError, match="note_probe.json"):
        check_entity_layout(TypeInfo(type_name=TYPE, shape=Folder(main="note.md"), asset_spec=_NoteSpec, manifest_layout=ENTITY_LAYOUT))
    with pytest.raises(TypeError, match="JsonRoot"):
        check_entity_layout(TypeInfo(type_name=TYPE, shape=Folder.entity_json(TYPE), asset_spec=_NoteSpec,
                                     manifest_layout=ENTITY_LAYOUT, identity_carrier=Sidecar()))
