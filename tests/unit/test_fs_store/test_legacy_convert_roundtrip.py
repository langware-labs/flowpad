"""Every retired id form converts into its carrier's live form: same id, the
legacy bytes gone, and a second resolve changes nothing.

    comment capsule            → frontmatter ``id:``        (block stripped)
    ``asset_id:``              → frontmatter ``id:``        (key dropped)
    ``.flow/id`` under SKILL.md → frontmatter ``id:``       (line deleted)
    json capsule under SKILL.md → frontmatter ``id:``       (capsule deleted)
    ``.flow/id`` under a folder → ``.flow/capsules/identity.json`` (line deleted)
    manifest ``id``            → ``.flow/capsules/identity.json`` (manifest kept)

Each hit is one ``legacy_form`` scan issue, recorded once per path.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from flow_sdk.capsules import AssetCapsule, CapsuleData
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_carrier import Found, Sidecar
from flow_sdk.fs_store.indexer import index_log
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    folder_capsule_id,
    folder_capsule_json_id,
    frontmatter_identity,
    in_folder,
)
from flow_sdk.fs_store.indexer.index_log import read_scan_issues
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File, Folder

pytestmark = pytest.mark.timeout(5)

ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
DOC = TypeInfo(type_name="legacy_doc", shape=File(ext=".md"), identity_carrier=frontmatter_identity())
SKILL_LIKE = TypeInfo(
    type_name="legacy_skill",
    shape=Folder(main="SKILL.md"),
    identity_carrier=frontmatter_identity(folder_capsule_json_id, in_folder(folder_capsule_id)),
)


def _manifest_id(ref) -> object | None:
    path = Path(getattr(ref, "_path", ref))
    try:
        return json.loads((path / "manifest.json").read_text(encoding="utf-8")).get("id")
    except OSError:
        return None


FOLDER_LIKE = TypeInfo(
    type_name="legacy_folder", shape=Folder(), identity_carrier=Sidecar(legacy=(folder_capsule_id, _manifest_id))
)


def _fm(path: Path) -> dict:
    return _yaml_load(_extract_frontmatter(path.read_text(encoding="utf-8")) or "") or {}


def _snapshot(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def _resolve_twice(info: TypeInfo, path: Path, root: Path, tmp_path: Path) -> dict[str, bytes]:
    """Resolve, snapshot, resolve again: same id, same bytes."""
    index_log._legacy_noted.clear()
    with patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: tmp_path / "schema"):
        assert info.mint_entity_id(FSRef(path)) == ID
        after_first = _snapshot(root)
        assert info.mint_entity_id(FSRef(path)) == ID
        assert info.mint_entity_id(FSRef(path)) == ID
        issues = read_scan_issues(info.type_name)
    assert _snapshot(root) == after_first, "the second resolve is byte-identical"
    assert [i.kind for i in issues] == ["legacy_form"], "one issue per path, however often it is read"
    return after_first


def test_comment_capsule_moves_into_the_header(tmp_path: Path) -> None:
    doc = tmp_path / "note.md"
    doc.write_text("---\ntitle: Note\n---\n\nbody\n", encoding="utf-8")
    AssetCapsule.from_path(doc).write("identity", CapsuleData(1, {"id": ID}))
    AssetCapsule.from_path(doc).write("tag", CapsuleData(1, {"tags": ["x"]}))
    assert DOC.carrier.read(doc) == Found(ID, "capsule", legacy=True)

    _resolve_twice(DOC, doc, tmp_path, tmp_path)
    text = doc.read_text(encoding="utf-8")
    assert _fm(doc) == {"id": ID, "title": "Note"}
    assert "flowpad:capsule identity" not in text and "flowpad:capsule tag" in text, "only the identity block goes"
    assert DOC.carrier.read(doc) == Found(ID, "frontmatter")


def test_asset_id_key_becomes_id(tmp_path: Path) -> None:
    doc = tmp_path / "note.md"
    doc.write_text(f"---\nasset_id: {ID}\ntitle: Note\n---\n\nbody\n", encoding="utf-8")
    assert DOC.carrier.read(doc) == Found(ID, "frontmatter_asset_id", legacy=True)

    _resolve_twice(DOC, doc, tmp_path, tmp_path)
    assert _fm(doc) == {"id": ID, "title": "Note"}


def test_flow_id_under_a_markdown_main_moves_into_the_header(tmp_path: Path) -> None:
    skill = tmp_path / "skills" / "x"
    (skill / ".flow").mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: x\n---\n\nbody\n", encoding="utf-8")
    (skill / ".flow" / "id").write_text(ID + "\n", encoding="utf-8")
    assert SKILL_LIKE.carrier.read(skill / "SKILL.md") == Found(ID, "folder_capsule_id", legacy=True)

    _resolve_twice(SKILL_LIKE, skill, skill, tmp_path)
    assert _fm(skill / "SKILL.md") == {"id": ID, "name": "x"}
    assert not (skill / ".flow" / "id").exists()


def test_json_capsule_under_a_markdown_main_moves_into_the_header(tmp_path: Path) -> None:
    skill = tmp_path / "skills" / "x"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: x\n---\n\nbody\n", encoding="utf-8")
    AssetCapsule.from_path(skill).write("identity", CapsuleData(1, {"id": ID}))
    assert SKILL_LIKE.carrier.read(skill / "SKILL.md") == Found(ID, "folder-json", legacy=True)

    _resolve_twice(SKILL_LIKE, skill, skill, tmp_path)
    assert _fm(skill / "SKILL.md") == {"id": ID, "name": "x"}
    assert not (skill / ".flow" / "capsules" / "identity.json").exists()


def test_flow_id_under_a_folder_becomes_the_json_capsule(tmp_path: Path) -> None:
    folder = tmp_path / "f"
    (folder / ".flow").mkdir(parents=True)
    (folder / ".flow" / "id").write_text(ID + "\n", encoding="utf-8")
    assert FOLDER_LIKE.carrier.read(folder) == Found(ID, "folder_capsule_id", legacy=True)

    _resolve_twice(FOLDER_LIKE, folder, folder, tmp_path)
    assert AssetCapsule.from_path(folder).read("identity").data == {"id": ID}
    assert not (folder / ".flow" / "id").exists()
    assert FOLDER_LIKE.carrier.read(folder) == Found(ID, "folder-json")


def test_manifest_id_becomes_the_json_capsule_and_the_manifest_is_kept(tmp_path: Path) -> None:
    folder = tmp_path / "f"
    folder.mkdir()
    manifest = folder / "manifest.json"
    manifest.write_text(json.dumps({"id": ID, "title": "t"}), encoding="utf-8")
    before = manifest.read_bytes()
    assert FOLDER_LIKE.carrier.read(folder) == Found(ID, "_manifest_id", legacy=True)

    _resolve_twice(FOLDER_LIKE, folder, folder, tmp_path)
    assert AssetCapsule.from_path(folder).read("identity").data == {"id": ID}
    assert manifest.read_bytes() == before, "the manifest is the asset's document, not a carrier"


def test_a_foreign_legacy_carrier_of_another_id_is_left_alone(tmp_path: Path) -> None:
    """The folder-side cleanup only removes a form naming THIS id."""
    other = "99999999-8888-4777-8666-555555555555"
    doc = tmp_path / "note.md"
    doc.write_text("body\n", encoding="utf-8")
    AssetCapsule.from_path(doc).write("identity", CapsuleData(1, {"id": ID}))
    (tmp_path / ".flow").mkdir()
    (tmp_path / ".flow" / "id").write_text(other + "\n", encoding="utf-8")

    _resolve_twice(DOC, doc, tmp_path, tmp_path)
    assert (tmp_path / ".flow" / "id").read_text(encoding="utf-8").strip() == other


def test_reading_alone_never_converts(tmp_path: Path) -> None:
    doc = tmp_path / "note.md"
    doc.write_text(f"---\nasset_id: {ID}\n---\n\nbody\n", encoding="utf-8")
    before = doc.read_bytes()
    assert DOC.mint_entity_id(FSRef(doc, read_only=True)) == ID
    assert doc.read_bytes() == before
