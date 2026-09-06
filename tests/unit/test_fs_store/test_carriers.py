"""Each carrier enforces its own format: it reads and writes only its own kind."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.fs_store.identity_carrier import (
    ABSENT,
    Derived,
    Foreign,
    Found,
    Frontmatter,
    JsonRoot,
    NotWritable,
    Sidecar,
)

V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


def test_frontmatter_roundtrip(tmp_path: Path) -> None:
    doc = tmp_path / "note.md"
    doc.write_text("---\ntitle: T\n---\n\nbody\n", encoding="utf-8")
    carrier = Frontmatter()
    assert carrier.read(doc) is ABSENT
    assert carrier.stamp(doc, V4) == V4
    assert carrier.read(doc) == Found(V4)
    assert doc.read_text(encoding="utf-8").startswith(f"---\nid: {V4}\ntitle: T\n---")
    assert carrier.stamp(doc, "99999999-8888-4777-8666-555555555555") == V4, "a Found id wins"


def test_frontmatter_refuses_a_python_file(tmp_path: Path) -> None:
    py = tmp_path / "a.py"
    py.write_text("pass\n", encoding="utf-8")
    before = py.read_bytes()
    assert not Frontmatter().accepts(py)
    with pytest.raises(NotWritable):
        Frontmatter().stamp(py, V4)
    assert py.read_bytes() == before


def test_sidecar_refuses_a_file_and_writes_the_folder_json(tmp_path: Path) -> None:
    doc = tmp_path / "note.md"
    doc.write_text("body\n", encoding="utf-8")
    with pytest.raises(NotWritable):
        Sidecar().stamp(doc, V4)
    folder = tmp_path / "asset"
    folder.mkdir()
    assert Sidecar().read(folder) is ABSENT
    assert Sidecar().stamp(folder, V4) == V4
    assert json.loads((folder / ".flow" / "capsules" / "identity.json").read_text())["data"]["id"] == V4
    assert Sidecar().read(folder) == Found(V4)


def test_jsonroot_reports_a_foreign_id(tmp_path: Path) -> None:
    report = tmp_path / "report.json"
    report.write_text(json.dumps({"id": "not-a-uuid", "n": 1}), encoding="utf-8")
    assert JsonRoot().read(report) == Foreign("not-a-uuid", "native-json")
    blank = tmp_path / "blank.json"
    blank.write_text("{}", encoding="utf-8")
    assert JsonRoot().stamp(blank, V4) == V4 and json.loads(blank.read_text())["id"] == V4


def test_derived_is_pure_and_never_writes(tmp_path: Path) -> None:
    src = tmp_path / "session.jsonl"
    src.write_text("{}\n", encoding="utf-8")
    assert Derived().read(src) is ABSENT
    assert Derived(reader=lambda p: V4).read(src) == Found(V4)
    assert Derived(reader=lambda p: "slug").read(src) is ABSENT
    with pytest.raises(NotWritable):
        Derived().stamp(src, V4)
    assert src.read_text(encoding="utf-8") == "{}\n"
