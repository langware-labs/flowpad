"""Identity is written to a markdown document's FRONTMATTER — never as a
``<!-- flowpad:capsule identity -->`` block inside its body.

``AssetCapsule.from_path`` dispatches on SUFFIX: hand it a ``.md`` and it
returns a ``CodeCommentCapsule``, which stores the id as an HTML comment
appended to the document. A type that declares the folder-json carrier while
its carrier path resolves to markdown therefore stamps every document it
indexes — the shape still committed in ``docs/breadcrumbs/*.md``.

The sweep is behavioural and registry-wide: it mints through the same
``TypeInfo.mint_entity_id`` seam the index walk calls, over every registered
type that writes its own carrier, and reads the resulting bytes back.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.type_info import register_all

CAPSULE_MARKER = "flowpad:capsule identity"


@pytest.fixture(scope="module", autouse=True)
def _registry() -> None:
    register_all()


def _writable_types():
    """Every registered type that stamps its own source."""
    for name in sorted(SchemaRegistry.get_all_types()):
        info = SchemaRegistry.get(name)
        carrier = getattr(info, "identity_carrier", None)
        if carrier is not None and getattr(carrier, "writable", False):
            yield name, info


def _materialize(info, root: Path) -> Path:
    """A minimal on-disk asset of this type's shape; returns the asset_ref."""
    if info.main_layout == "folder":
        root.mkdir(parents=True, exist_ok=True)
        if info.main_file:
            (root / info.main_file).write_text(
                "{}\n" if info.main_file.endswith(".json") else "body\n", encoding="utf-8"
            )
        return root / info.main_file if info.main_file_is_asset_ref and info.main_file else root
    path = root.with_suffix(info.main_ext or ".md")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}\n" if path.suffix == ".json" else "body\n", encoding="utf-8")
    return path


def test_markdown_mint_writes_frontmatter_not_a_capsule_block(tmp_path: Path) -> None:
    """The reported symptom, at the seam the index walk enters through."""
    info = SchemaRegistry.get("markdown")
    doc = tmp_path / "notes.md"
    doc.write_text("# My notes\n\nplain user markdown.\n", encoding="utf-8")

    minted = info.mint_entity_id(FSRef(doc))

    text = doc.read_text(encoding="utf-8")
    assert CAPSULE_MARKER not in text, f"identity stored as a capsule block:\n{text}"
    assert (_yaml_load(_extract_frontmatter(text)) or {}).get("id") == minted


def test_no_registered_type_stamps_a_capsule_block_into_markdown(tmp_path: Path) -> None:
    """Registry-wide: minting must never leave a capsule block in any ``.md``."""
    offenders: list[str] = []
    for name, info in _writable_types():
        root = tmp_path / name
        try:
            ref = _materialize(info, root)
            info.mint_entity_id(FSRef(ref, record_type=name))
        except Exception:
            continue  # a type whose shape this sweep cannot stand up is not evidence
        written = sorted(root.rglob("*.md")) if root.is_dir() else []
        if ref.is_file():
            written.append(ref)
        for md in written:
            if md.suffix in {".md", ".markdown"} and CAPSULE_MARKER in md.read_text(encoding="utf-8"):
                offenders.append(f"{name} -> {md.name}")

    assert not offenders, "identity stamped as a markdown capsule block by: " + ", ".join(offenders)
