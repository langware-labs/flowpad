"""A FLAT json manifest (``webapp.json``) is edited as a document: patched by field, validated by its spec,
revision-checked, and written as plain JSON — never a YAML frontmatter, never a stamped ``type``."""
from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

import flow_sdk.schema.type_info  # noqa: F401 — registers micro_app
from flow_sdk.assets.document import DocumentConflict, DocumentPatch, read_document, update_document
from flow_sdk.assets.entity_document import entity_info_for

pytestmark = pytest.mark.timeout(5)  # do not increase without approval

ADMIN = {
    "audience": "admin",
    "serving": {"type": "proxy", "start_cmd": "bash run-page.sh {port}", "ports": {"local": {"port": 3300, "required": False}}},
}


@pytest.fixture
def manifest(tmp_path):
    folder = tmp_path / "agentic-assets" / "webapp" / "spora-admin"
    folder.mkdir(parents=True)
    path = folder / "webapp.json"
    path.write_text(json.dumps({"name": "spora-admin", "title": "Spora Admin", "mounts": [ADMIN]}, indent=2) + "\n")
    return path


def test_webapp_json_is_a_document_of_its_spec(manifest):
    assert entity_info_for(manifest) is not None
    doc = read_document(manifest)
    assert doc.fields["title"] == "Spora Admin" and doc.fields["mounts"][0]["audience"] == "admin"


def test_a_patch_writes_plain_json_with_no_type(manifest):
    before = read_document(manifest)
    mount = {**ADMIN, "audience": "app"}
    update_document(manifest, DocumentPatch(set_fields={"mounts": [mount], "description": "Ops"}), expected_revision=before.revision)
    stored = json.loads(manifest.read_text())
    assert "type" not in stored and not manifest.read_text().startswith("---")
    assert stored["mounts"][0]["audience"] == "app" and stored["description"] == "Ops" and stored["name"] == "spora-admin"


def test_switching_to_a_folder_drops_the_command_fields(manifest):
    update_document(manifest, DocumentPatch(set_fields={"mounts": [{"audience": "admin", "serving": {"type": "static", "root": ""}}]}))
    serving = json.loads(manifest.read_text())["mounts"][0]["serving"]
    assert serving == {"type": "static", "root": ""}


@pytest.mark.parametrize("bad", [
    {"audience": "admin", "serving": {"type": "proxy", "start_cmd": "x", "ports": {"local": {"port": 70000}}}},
    {"audience": "admin", "path": "Not A Path!", "serving": {"type": "static"}},
    {"audience": "nobody", "serving": {"type": "static"}},
])
def test_a_bad_value_is_refused_and_the_file_is_unchanged(manifest, bad):
    text = manifest.read_text()
    with pytest.raises(ValidationError):
        update_document(manifest, DocumentPatch(set_fields={"mounts": [bad]}))
    assert manifest.read_text() == text


def test_a_stale_revision_is_a_conflict(manifest):
    stale = read_document(manifest).revision
    update_document(manifest, DocumentPatch(set_fields={"description": "first"}))
    with pytest.raises(DocumentConflict):
        update_document(manifest, DocumentPatch(set_fields={"description": "second"}), expected_revision=stale)
    assert json.loads(manifest.read_text())["description"] == "first"


def test_only_a_declared_flat_manifest_takes_this_path(tmp_path):
    """An undeclared layout is not assumed flat: a data driver's JSON keeps its own writer."""
    folder = tmp_path / "agentic-assets" / "data_driver" / "feed"
    folder.mkdir(parents=True)
    path = folder / "data_driver.json"
    path.write_text("{}\n")
    assert entity_info_for(path) is None
