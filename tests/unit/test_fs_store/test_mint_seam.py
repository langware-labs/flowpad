"""``TypeInfo.mint`` — the MINT step over a classified layout."""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.identity_carrier import ForeignId, Frontmatter, Unstamped
from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_identity
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File, Folder

V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
INFO = TypeInfo(type_name="probe", shape=File(ext=".md"), identity_carrier=Frontmatter())


def test_found_returns_without_writing(tmp_path: Path) -> None:
    doc = tmp_path / "a.md"
    doc.write_text(f"---\nid: {V4}\n---\nbody\n", encoding="utf-8")
    before = doc.read_bytes()
    assert INFO.mint(INFO.layout_of(doc)) == V4
    assert doc.read_bytes() == before


def test_foreign_raises(tmp_path: Path) -> None:
    doc = tmp_path / "a.md"
    doc.write_text("---\nid: 018f0000-0000-7000-8000-000000000000\n---\nbody\n", encoding="utf-8")
    with pytest.raises(ForeignId):
        INFO.mint(INFO.layout_of(doc))


def test_no_write_keyless_raises_unstamped_and_keeps_bytes(tmp_path: Path) -> None:
    doc = tmp_path / "a.md"
    doc.write_text("body\n", encoding="utf-8")
    with pytest.raises(Unstamped):
        INFO.mint(INFO.layout_of(doc), write=False)
    assert doc.read_text(encoding="utf-8") == "body\n"


def test_no_write_keyed_answers_the_v5(tmp_path: Path) -> None:
    keyed = TypeInfo(type_name="keyed", shape=File(ext=".md"), identity_carrier=Frontmatter(), id_stable_key_fn=lambda r: "k")
    doc = tmp_path / "a.md"
    doc.write_text("body\n", encoding="utf-8")
    assert keyed.mint(keyed.layout_of(doc), write=False) == str(uuid.uuid5(uuid.NAMESPACE_URL, "k"))


def test_folder_and_main_file_mint_the_same_id(tmp_path: Path) -> None:
    info = TypeInfo(
        type_name="probe_folder", shape=Folder(main="PROBE.md"),
        identity_carrier=frontmatter_identity(),
    )
    folder = tmp_path / "s"
    folder.mkdir()
    (folder / "PROBE.md").write_text("body\n", encoding="utf-8")
    minted = info.mint(info.layout_of(folder))
    assert uuid.UUID(minted).version == 4
    assert info.mint(info.layout_of(folder / "PROBE.md")) == minted
    assert not (folder / ".flow").exists(), "the sidecar json is never written by a frontmatter carrier"
