"""``.docx`` / ``.txt`` files in a docs folder are Documents (the DOCUMENT_FILE type).

Covers the three places a docs folder is read: the indexer's per-folder
emitter, the extractor (text for search), and the Documents tree walk.
Real files in ``tmp_path`` — no mocks.
"""
from __future__ import annotations

import zipfile
from pathlib import Path

import flow_sdk.models.entities  # noqa: F401 — registers the types
from flow_sdk.assets.types.document_file import extract_document_file
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.markdown import document_files_in_folder_fn, markdown_in_folder_fn
from flow_sdk.fs_store.operations.markdown_dirs import walk_markdown_files
from flow_sdk.fs_store.record_types import RecordType

_DOC_XML = (
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    "<w:p><w:r><w:t>Privacy </w:t></w:r><w:r><w:t>policy</w:t></w:r></w:p>"
    "<w:p><w:r><w:t>Second line</w:t></w:r></w:p>"
    "</w:body></w:document>"
)


def _project(tmp_path: Path) -> tuple[FSRef, Path]:
    docs = tmp_path / "website" / "docs"
    docs.mkdir(parents=True)
    (docs / "report.md").write_text("# r", encoding="utf-8")
    (docs / "notes.txt").write_text("plain words", encoding="utf-8")
    with zipfile.ZipFile(docs / "terms.docx", "w") as zf:
        zf.writestr("word/document.xml", _DOC_XML)
    (tmp_path / "requirements.txt").write_text("x", encoding="utf-8")  # not in a docs folder
    root = FSRef(tmp_path, record_type=RecordType.FOLDER)
    return root, docs


def _folders(root: FSRef, *dirs: Path) -> list[FSRef]:
    return [FSRef(d, record_type=RecordType.FOLDER, parent=root) for d in dirs]


def test_docs_folder_emits_docx_and_txt_as_document_files(tmp_path: Path) -> None:
    root, docs = _project(tmp_path)
    folders = _folders(root, tmp_path, docs)

    refs = document_files_in_folder_fn(folders, None)

    assert sorted(Path(r.path).name for r in refs) == ["notes.txt", "terms.docx"]
    assert {r.record_type for r in refs} == {RecordType.DOCUMENT_FILE}
    # markdown keeps only the .md, so no file is claimed twice
    assert [Path(r.path).name for r in markdown_in_folder_fn(folders, None)] == ["report.md"]


def test_extractor_reads_docx_and_txt_text_for_search(tmp_path: Path) -> None:
    _root, docs = _project(tmp_path)

    (docx,) = extract_document_file(FSRef(docs / "terms.docx"), "id-1")
    (txt,) = extract_document_file(FSRef(docs / "notes.txt"), "id-2")

    assert docx.type == RecordType.DOCUMENT_FILE
    assert docx.content == "terms\nPrivacy policy\nSecond line"
    assert txt.content == "notes\nplain words"
    assert extract_document_file(FSRef(docs / "report.md"), "id-3") == []


def test_documents_tree_lists_docx_and_txt(tmp_path: Path) -> None:
    _project(tmp_path)

    assert walk_markdown_files(tmp_path) == [
        "website/docs/notes.txt",
        "website/docs/report.md",
        "website/docs/terms.docx",
    ]
