"""A retired id form is FOREIGN: the carrier does not adopt it, the walk
records a ``foreign_id`` scan issue that names the migration, and the bytes
are never touched. The forms: a folder's ``.flow/id`` line, the ``asset_id:``
frontmatter key, the HTML-comment ``identity`` capsule."""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.capsules import AssetCapsule, CapsuleData
from flow_sdk.fs_store.identity_carrier import RETIRED_FORM_MIGRATION, Foreign, Frontmatter, Sidecar
from flow_sdk.fs_store.indexer import index_log
from flow_sdk.fs_store.indexer.reconcile import reconcile
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File, Folder

OLD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
DOC = TypeInfo(type_name="legacy_doc", shape=File(ext=".md"), identity_carrier=Frontmatter())
SKILL_LIKE = TypeInfo(type_name="legacy_skill", shape=Folder(main="PROBE.md"), identity_carrier=Frontmatter())
FOLDER_LIKE = TypeInfo(type_name="legacy_folder", shape=Folder(), identity_carrier=Sidecar())


@pytest.fixture(autouse=True)
def _issues(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(index_log, "_schema_dir", lambda: tmp_path / "schema")


def _asset_id_doc(root: Path) -> Path:
    doc = root / "note.md"
    doc.write_text(f"---\nasset_id: {OLD}\ntitle: Note\n---\n\nnote\n", encoding="utf-8")
    return doc


def _capsule_doc(root: Path) -> Path:
    doc = root / "agent.md"
    doc.write_text("---\ntitle: Agent\n---\n\nprompt\n", encoding="utf-8")
    AssetCapsule.from_path(doc).write("identity", CapsuleData(1, {"id": OLD}))
    return doc


def _flow_id_skill(root: Path) -> Path:
    skill = root / "skill"
    (skill / ".flow").mkdir(parents=True)
    (skill / "PROBE.md").write_text("---\nname: s\n---\n\nbody\n", encoding="utf-8")
    (skill / ".flow" / "id").write_text(OLD + "\n", encoding="utf-8")
    return skill


def _flow_id_folder(root: Path) -> Path:
    folder = root / "folder"
    (folder / ".flow").mkdir(parents=True)
    (folder / ".flow" / "id").write_text(OLD + "\n", encoding="utf-8")
    return folder


CASES = [
    (DOC, _asset_id_doc, "retired:asset_id"),
    (DOC, _capsule_doc, "retired:capsule"),
    (SKILL_LIKE, _flow_id_skill, "retired:flow-id"),
    (FOLDER_LIKE, _flow_id_folder, "retired:flow-id"),
]


@pytest.mark.parametrize(("info", "make", "source"), CASES, ids=[c[2] + "/" + c[0].type_name for c in CASES])
def test_the_carrier_reads_a_retired_form_as_foreign(tmp_path: Path, info: TypeInfo, make, source: str) -> None:
    path = make(tmp_path)
    found = info.carrier.read(info.carrier.locate(info.layout_of(path)))
    assert isinstance(found, Foreign) and found.source == source
    assert info.read_id(path) is None


@pytest.mark.parametrize(("info", "make", "source"), CASES, ids=[c[2] + "/" + c[0].type_name for c in CASES])
def test_the_walk_records_a_foreign_id_issue_naming_the_migration(tmp_path: Path, info: TypeInfo, make, source: str) -> None:
    path = make(tmp_path)
    before = {p: p.read_bytes() for p in path.rglob("*") if p.is_file()} if path.is_dir() else path.read_bytes()

    layout = info.layout_of(path)
    answered = reconcile(info, layout, None, None, write=True)

    assert answered != OLD, "the retired id is not adopted"
    assert answered == str(uuid.uuid5(uuid.NAMESPACE_URL, str(layout.ref.resolve())))
    after = {p: p.read_bytes() for p in path.rglob("*") if p.is_file()} if path.is_dir() else path.read_bytes()
    assert after == before, "a foreign carrier is never rewritten"

    [issue] = index_log.read_scan_issues(info.type_name)
    assert issue.kind == "foreign_id" and issue.detail.startswith(source)
    assert RETIRED_FORM_MIGRATION in issue.detail


def test_a_live_id_beside_a_retired_form_wins_silently(tmp_path: Path) -> None:
    doc = tmp_path / "note.md"
    doc.write_text(f"---\nid: {OLD}\nasset_id: 99999999-8888-4777-8666-555555555555\n---\n\nnote\n", encoding="utf-8")
    assert DOC.read_id(doc) == OLD
    assert index_log.read_scan_issues(DOC.type_name) == []
