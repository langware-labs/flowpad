"""An entity document (``<type>.json`` + its body file) is read and patched as ONE ``AssetDocument``:
the revision spans both files, identity is never patched, every field change passes the spec."""
from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.assets import document as document_module
from flow_sdk.assets.document import DocumentConflict, DocumentPatch
from flow_sdk.assets.entity_document import patch_entity_document, read_entity_document
from flow_sdk.assets.versioning import strip_version
from tests.unit._entity_document_probe import TYPE, info

pytestmark = pytest.mark.timeout(5)  # do not increase without approval

INFO = info()


@pytest.fixture
def note(tmp_path):
    root = tmp_path / "hello"
    root.mkdir()
    entity_id = str(uuid.uuid4())
    (root / f"{TYPE}.json").write_text(json.dumps({"type": TYPE, "id": entity_id, "name": "hello", "title": "Hi"}, indent=2) + "\n")
    (root / "text.md").write_text("The body.\n")
    return root / f"{TYPE}.json", entity_id


def test_the_document_is_the_json_fields_and_the_body_file(note):
    main, _ = note
    doc = read_entity_document(main, INFO)
    assert doc.fields == {"name": "hello", "title": "Hi"} and doc.body == "The body.\n"
    assert doc.revision == read_entity_document(main, INFO).revision


def test_a_patch_writes_the_field_and_the_body_and_keeps_identity_first(note):
    main, entity_id = note
    before = read_entity_document(main, INFO)
    after = patch_entity_document(main, DocumentPatch(body="New body.\n", set_fields={"tags": ["x"]}), expected_revision=before.revision, info=INFO)
    stored = json.loads(main.read_text())
    assert list(stored)[:2] == ["type", "id"] and stored["id"] == entity_id and stored["tags"] == ["x"]
    assert (main.parent / "text.md").read_text() == "New body.\n"
    assert after.revision != before.revision and after.body == "New body.\n"


def test_a_dropped_field_is_gone_from_the_returned_document(note):
    """The editor adopts the returned fields as its draft: a dropped key echoed back comes back to life."""
    main, _ = note
    before = read_entity_document(main, INFO)
    after = patch_entity_document(main, DocumentPatch(drop_fields=("title",)), expected_revision=before.revision, info=INFO)
    assert "title" not in json.loads(main.read_text())
    assert "title" not in after.fields and after.revision == read_entity_document(main, INFO).revision


def test_a_stale_revision_writes_nothing(note):
    main, _ = note
    text = main.read_text()
    with pytest.raises(DocumentConflict):
        patch_entity_document(main, DocumentPatch(set_fields={"title": "Late"}), expected_revision="sha256:old", info=INFO)
    assert main.read_text() == text


def test_identity_and_invalid_fields_are_refused(note):
    main, _ = note
    with pytest.raises(ValueError, match="identity"):
        patch_entity_document(main, DocumentPatch(set_fields={"id": str(uuid.uuid4())}), info=INFO)
    with pytest.raises(ValueError):
        patch_entity_document(main, DocumentPatch(set_fields={"tags": "not a list"}), info=INFO)


def test_a_noop_patch_keeps_the_bytes(note):
    main, _ = note
    text, mtime = main.read_text(), main.stat().st_mtime_ns
    patch_entity_document(main, DocumentPatch(set_fields={"title": "Hi"}, body="The body.\n"), info=INFO)
    assert (main.read_text(), main.stat().st_mtime_ns) == (text, mtime)


def test_a_change_against_the_committed_text_bumps_the_version(note):
    main, _ = note
    committed = main.read_text()
    patch_entity_document(main, DocumentPatch(set_fields={"title": "Changed"}), version_base=committed, info=INFO)
    assert json.loads(main.read_text())["version"] == 2


def test_the_generic_document_calls_route_an_entity_document(note, monkeypatch):
    main, _ = note
    monkeypatch.setattr("flow_sdk.assets.entity_document.entity_info_for", lambda path: INFO if str(path).endswith(".json") else None)
    assert document_module.read_document(main).body == "The body.\n"
    document_module.update_document(main, DocumentPatch(set_fields={"title": "Routed"}))
    assert json.loads(main.read_text())["title"] == "Routed"


def test_a_version_only_difference_is_not_a_change():
    a = json.dumps({"type": TYPE, "id": "1", "title": "x", "version": 2})
    b = json.dumps({"version": 3, "type": TYPE, "id": "1", "title": "x"})
    assert strip_version(a) == strip_version(b)
