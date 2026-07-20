"""Tests for ``DeckTemplate.from_fs_ref`` — the generic, DB-free on-disk loader.

``Entity.from_fs_ref(ref)`` dispatches to the type's registered cold-path parser
(``TypeInfo.from_disk_fn`` == ``extract_deck_template``) and builds the entity
generically from the returned ``FSRecord``. These tests assert it is fully
indexer-compatible: id, typed fields, and denormalized layout data match the
cold path. Modeled on ``test_dataset_from_fs_ref.py``.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.deck_template import DeckTemplate
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.deck_template import (
    extract_deck_template,
)

# do not increase timeout without approval — these are pure-sync parses (<1s).
pytestmark = pytest.mark.timeout(5)

# A real v4 uuid for manifest-id adoption tests.
VALID_V4 = "a3f1c2d4-5b6e-4f7a-8c9d-0e1f2a3b4c5d"


def _doc(metadata: dict | None = None, data: dict | None = None) -> str:
    return json.dumps({"metadata": metadata or {}, "data": data or {}})


def _seed_template(
    project: Path,
    slug: str,
    *,
    manifest: dict | None = None,
    manifest_data: dict | None = None,
    layouts: list[str] = (),
) -> Path:
    tpl = project / "assets" / "deck-templates" / slug
    tpl.mkdir(parents=True)
    (tpl / "template.json").write_text(
        _doc(metadata=manifest, data=manifest_data), encoding="utf-8"
    )
    for name in layouts:
        path = tpl / "layouts" / f"{name}.html"
        path.parent.mkdir(exist_ok=True)
        path.write_text(
            f'<section class="layout layout-{name}" data-layout="{name}"></section>',
            encoding="utf-8",
        )
    return tpl


def _assert_indexer_compatible(tpl_path: Path) -> DeckTemplate:
    """Load via from_fs_ref and assert it equals the indexer cold path."""
    ref = FSRef(tpl_path)
    # gen_id stamps the `.flow/id` capsule first — the production index order.
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    gen = SchemaRegistry.get("deck_template").mint_id(ref)
    loaded = DeckTemplate.from_fs_ref(ref)
    assert loaded is not None, "from_fs_ref returned None for a real deck template"
    assert isinstance(loaded, DeckTemplate)

    rec = extract_deck_template(ref, gen)[0]
    meta = rec.meta_dict()["metadata"]

    assert loaded.id == gen == rec.id
    assert loaded.layouts == meta["layouts"]
    assert loaded.page_types == meta["page_types"]
    assert loaded.num_layouts == meta["num_layouts"]
    return loaded


def test_returns_typed_instance(tmp_path: Path) -> None:
    tpl = _seed_template(tmp_path, "t", layouts=["cover-centered"])
    loaded = DeckTemplate.from_fs_ref(FSRef(tpl))
    assert type(loaded) is DeckTemplate  # resolved via the registry, not base Entity


def test_non_template_folder_returns_none(tmp_path: Path) -> None:
    plain = tmp_path / "not_a_template"
    plain.mkdir()
    (plain / "readme.txt").write_text("hi", encoding="utf-8")
    assert DeckTemplate.from_fs_ref(FSRef(plain)) is None


def test_asset_ref_stamped_and_layout_html_reads(tmp_path: Path) -> None:
    tpl = _seed_template(tmp_path, "t", layouts=["cover-centered"])
    loaded = DeckTemplate.from_fs_ref(FSRef(tpl))
    assert loaded.asset_ref == str(Path(tpl).resolve())
    html = loaded.layout_html("cover-centered")
    assert html is not None and 'data-layout="cover-centered"' in html
    assert loaded.layout_html("missing-layout") is None


def test_comprehensive_all_fields(tmp_path: Path) -> None:
    tpl = _seed_template(
        tmp_path,
        "full",
        manifest={
            "id": VALID_V4,
            "title": "Full",
            "description": "every field",
            "page_types": ["cover", "metrics"],
        },
        manifest_data={"brand": "acme"},
        layouts=["cover-centered", "metrics-grid"],
    )
    loaded = _assert_indexer_compatible(tpl)
    assert loaded.id == VALID_V4  # manifest id adopted
    assert loaded.title == "Full"
    assert loaded.description == "every field"
    assert loaded.layouts == ["cover-centered", "metrics-grid"]
    assert loaded.page_types == ["cover", "metrics"]
    assert loaded.num_layouts == 2
    assert loaded.data == {"brand": "acme"}
    assert loaded.asset_ref == str(Path(tpl).resolve())


def test_determinism_stable_ids(tmp_path: Path) -> None:
    tpl = _seed_template(tmp_path, "det", layouts=["blank-canvas"])
    a = DeckTemplate.from_fs_ref(FSRef(tpl))
    b = DeckTemplate.from_fs_ref(FSRef(tpl))
    assert a.id == b.id
