"""``File`` / ``Folder`` — the one shape declaration, asked in a REPL."""
from __future__ import annotations

from pathlib import Path

from flow_sdk.schema.layout import File, Folder, LayoutKind


def test_file_locates_by_extension_only(tmp_path: Path) -> None:
    shape = File(ext=".md")
    doc = tmp_path / "a.md"
    assert shape.locate(doc).kind is LayoutKind.FILE and shape.locate(doc).ref == doc
    assert shape.locate(tmp_path / "a.py").kind is LayoutKind.NONE
    assert shape.locate(doc, verify=True).kind is LayoutKind.NONE, "verify demands the file exist"
    doc.write_text("x", encoding="utf-8")
    assert shape.locate(doc, verify=True).body == doc


def test_folder_locates_the_folder_or_its_main_document(tmp_path: Path) -> None:
    shape = Folder(main="SKILL.md")
    folder = tmp_path / "s"
    folder.mkdir()
    main = folder / "SKILL.md"
    assert shape.locate(folder).kind is LayoutKind.FOLDER and shape.locate(folder).body == main
    assert shape.locate(main).kind is LayoutKind.MAIN_FILE and shape.locate(main).root == folder
    assert shape.locate(folder, verify=True).kind is LayoutKind.NONE, "no main document yet"
    main.write_text("x", encoding="utf-8")
    assert shape.locate(folder, verify=True).root == folder
    assert shape.locate(folder / "notes.md").root == folder / "notes.md", "a sibling is not the main"


def test_folder_ref_spelling_follows_ref_is_main(tmp_path: Path) -> None:
    folder = tmp_path / "a"
    spec_style = Folder(main="agent.md", ref_is_main=True)
    assert spec_style.ref_for(folder) == folder / "agent.md"
    assert spec_style.root_of(folder / "agent.md") == folder
    assert Folder(main="SKILL.md").ref_for(folder) == folder
    assert spec_style.locate(folder).ref == folder / "agent.md"


def test_file_ext_is_normalized_to_a_lowercase_suffix() -> None:
    assert File(ext="MD").ext == ".md"
    assert File(ext=".Csv").ext == ".csv"
