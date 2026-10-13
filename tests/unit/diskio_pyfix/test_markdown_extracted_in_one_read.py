"""The generic extractor reads and parses a markdown asset ONCE per record.

It read the same file four times: frontmatter and body separately, and then the
whole main document again for the header ``row_derive_fn`` wants.
"""

from pathlib import Path

import pytest

from flow_sdk.assets import document
from flow_sdk.assets.serialization import read_asset_data, read_asset_data_with_header, read_main
from flow_sdk.fs_store.fs_ref import FrontMatterFsRef, FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

DOC_ID = "5f0c1c5e-7d0b-4c59-9d3e-2f0a4b1c9a11"
TEXT = f"---\nid: {DOC_ID}\ntitle: Tide tables\ntags:\n  - sea\n---\n\n# Tide tables\n\nHigh water at noon.\n"


@pytest.fixture
def info():
    from flow_sdk.core.asset_type_bindings import register_asset_runtime_bindings
    from flow_sdk.schema.type_info import register_all

    register_all()
    register_asset_runtime_bindings()
    return SchemaRegistry.get("markdown")


@pytest.fixture
def doc(tmp_path: Path) -> Path:
    path = tmp_path / "docs" / "tides.md"
    path.parent.mkdir()
    path.write_text(TEXT, encoding="utf-8")
    return path


@pytest.fixture
def reads(monkeypatch) -> list[Path]:
    seen: list[Path] = []
    real = document.read_document
    monkeypatch.setattr(document, "read_document", lambda path, *a, **k: seen.append(Path(path)) or real(path, *a, **k))
    return seen


def test_the_extractor_reads_the_file_once_and_derives_from_that_header(info, doc: Path, reads: list[Path], monkeypatch):
    assert info.row_derive_fn is not None  # the hook that used to cost the second pair of reads
    handed: list[dict] = []
    derive = info.row_derive_fn
    monkeypatch.setattr(info, "row_derive_fn", lambda data, root, header: handed.append(header) or derive(data, root, header))

    [record] = info.from_disk_fn(FSRef(doc, record_type=RecordType.MARKDOWN), DOC_ID)

    assert reads == [doc.resolve()]
    assert handed == [read_main(info, doc)[1]]
    assert handed[0]["title"] == "Tide tables" and handed[0]["tags"] == ["sea"]
    assert (str(record.id), record.type) == (DOC_ID, "markdown")
    assert "High water at noon." in record.content


def test_one_read_answers_what_the_two_reads_answered(doc: Path, tmp_path: Path, reads: list[Path]):
    ref = FrontMatterFsRef(doc)
    both = ref.read_frontmatter_and_body()
    assert len(reads) == 1
    assert both == (ref.read_frontmatter(), ref.read_body())
    assert both[1] == "# Tide tables\n\nHigh water at noon."

    bare = tmp_path / "bare.md"
    bare.write_text("no header here\n", encoding="utf-8")
    assert FrontMatterFsRef(bare).read_frontmatter_and_body() == ({}, "no header here")
    assert FrontMatterFsRef(tmp_path / "absent.md").read_frontmatter_and_body() == ({}, "")


def test_read_asset_data_is_the_record_half_of_the_pair(info, doc: Path):
    record, header = read_asset_data_with_header(doc, info, identity=DOC_ID)
    assert record.meta_dict() == read_asset_data(doc, info, identity=DOC_ID).meta_dict()
    assert header == read_main(info, doc)[1]


def test_an_undecodable_markdown_is_still_refused_not_half_read(info, tmp_path: Path):
    binary = tmp_path / "docs" / "blob.md"
    binary.parent.mkdir()
    binary.write_bytes(b"\xff\xfe\x00binary\x80")
    with pytest.raises(UnicodeError):
        read_main(info, binary)
    assert info.from_disk_fn(FSRef(binary, record_type=RecordType.MARKDOWN), DOC_ID) == []
