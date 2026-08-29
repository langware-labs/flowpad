"""``TypeInfo.layout_of`` — the one path→layout classifier every mapper projects."""
from pathlib import Path

from flow_sdk.fs_store.schema_registry import LayoutKind, TypeInfo

SKILL = TypeInfo(type_name="t_skill", main_layout="folder", main_file="SKILL.md")                       # skill-style
SPEC = TypeInfo(type_name="t_spec", main_layout="folder", main_file="spec.md", main_file_is_asset_ref=True)
DOC = TypeInfo(type_name="t_doc", main_layout="file", main_ext=".md")


def test_folder_types_classify_folder_and_inner_main_file(tmp_path: Path):
    folder = tmp_path / "foo"
    folder.mkdir()
    (folder / "SKILL.md").write_text("x")
    assert SKILL.layout_of(folder).kind is LayoutKind.FOLDER
    inner = SKILL.layout_of(folder / "SKILL.md")
    assert (inner.kind, inner.root, inner.body, inner.ref) == (LayoutKind.MAIN_FILE, folder, folder / "SKILL.md", folder)
    spec = SPEC.layout_of(folder / "spec.md")
    assert (spec.kind, spec.root, spec.ref) == (LayoutKind.MAIN_FILE, folder, folder / "spec.md")


def test_names_compare_case_insensitively_and_the_capsule_lands_on_the_folder(tmp_path: Path):
    folder = tmp_path / "agent"
    folder.mkdir()
    (folder / "AGENT.MD").write_text("x")
    info = TypeInfo(type_name="t_agent", main_layout="folder", main_file="agent.md", main_file_is_asset_ref=True)
    assert info.layout_of(folder / "AGENT.MD").kind is LayoutKind.MAIN_FILE
    assert info.storage_root_for(folder / "AGENT.MD") == folder
    assert SKILL.capsule_target_for(folder / "SKILL.MD") == folder


def test_verify_requires_the_bytes_and_projections_stay_total(tmp_path: Path):
    fresh = tmp_path / "new"                         # does not exist yet — a save target
    assert SKILL.layout_of(fresh, verify=True).kind is LayoutKind.NONE
    assert SKILL.body_path_for(fresh) == fresh / "SKILL.md"
    assert SKILL.storage_root_for(fresh / "SKILL.md") == fresh
    doc = tmp_path / "note.md"
    assert DOC.layout_of(doc, verify=True).kind is LayoutKind.NONE
    doc.write_text("x")
    assert DOC.layout_of(doc, verify=True).kind is LayoutKind.FILE
    assert DOC.layout_of(tmp_path / "note.txt").kind is LayoutKind.NONE
    assert DOC.storage_root_for(tmp_path / "note.txt") == tmp_path / "note.txt"


def test_a_directory_named_like_the_main_file_stays_a_directory(tmp_path: Path):
    weird = tmp_path / "SKILL.md"
    weird.mkdir()
    assert SKILL.layout_of(weird).kind is LayoutKind.FOLDER
    assert SKILL.storage_root_for(weird) == weird
