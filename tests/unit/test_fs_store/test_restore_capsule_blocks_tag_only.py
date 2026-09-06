"""A save carries every non-identity capsule across (the ``tag`` block the
tagit skill writes) and drops the ``identity`` block once the id is in the
header — the header is the carrier, the block is a retired form."""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.capsules import AssetCapsule, CapsuleData, snapshot_capsule_blocks
from flow_sdk.fs_store.fs_ref.frontmatter_ref import FrontMatterFsRef
from flow_sdk.fs_store.indexer._frontmatter import carry_capsules

pytestmark = pytest.mark.timeout(5)

ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


def _doc(tmp_path: Path, header: str) -> Path:
    path = tmp_path / "note.md"
    path.write_text(f"---\n{header}\n---\n\nold body\n", encoding="utf-8")
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": ID}))
    AssetCapsule.from_path(path).write("tag", CapsuleData(1, {"tags": ["alpha"]}))
    return path


def _names(text: str) -> list[str]:
    return [block.split()[2] for block in snapshot_capsule_blocks(text)]


def test_tag_survives_and_identity_is_dropped_once_the_id_is_in_the_header(tmp_path: Path) -> None:
    path = _doc(tmp_path, f"id: {ID}\ntitle: Note")
    FrontMatterFsRef(path).write_body("new body\n")
    text = path.read_text(encoding="utf-8")
    assert _names(text) == ["tag"]
    assert "new body" in text and f"id: {ID}" in text
    assert AssetCapsule.from_path(path).read("tag").data == {"tags": ["alpha"]}


def test_identity_block_is_carried_while_the_header_has_no_id(tmp_path: Path) -> None:
    path = _doc(tmp_path, "title: Note")
    FrontMatterFsRef(path).write_body("new body\n")
    assert _names(path.read_text(encoding="utf-8")) == ["identity", "tag"], "an unconverted id is never lost"


def test_write_doc_applies_the_same_rule(tmp_path: Path) -> None:
    path = _doc(tmp_path, "title: Note")
    FrontMatterFsRef(path).write_doc("\nnew body\n", {"id": ID, "title": "Note"})
    assert _names(path.read_text(encoding="utf-8")) == ["tag"]


def test_carry_capsules_is_a_pure_function_of_the_two_texts() -> None:
    old = f"---\ntitle: T\n---\n\nbody\n\n<!-- flowpad:capsule identity\nversion: 1\ndata:\n  id: {ID}\nflowpad:endcapsule identity -->\n\n<!-- flowpad:capsule tag\nversion: 1\ndata:\n  tags: []\nflowpad:endcapsule tag -->\n"
    assert _names(carry_capsules(f"---\nid: {ID}\n---\n\nnew\n", old)) == ["tag"]
    assert _names(carry_capsules("---\ntitle: T\n---\n\nnew\n", old)) == ["identity", "tag"]
    assert carry_capsules("plain\n", "no capsules here\n") == "plain\n"
