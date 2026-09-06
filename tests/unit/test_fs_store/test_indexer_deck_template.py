"""Indexer tests for the DECK_TEMPLATE type.

Covers the slot functions end-to-end:
- ``repo_assets_fn`` emits one FSRef per ``agentic-assets/deck_template/<slug>/``
  folder carrying a ``template.json`` manifest.
- ``extract_deck_template`` parses the manifest + ``layouts/`` into one FSRecord
  with denormalized layout data.
- the json capsule carries the id (idempotent; a manifest id is not a carrier).
- ``deck_template_asset_hash`` tracks inner layout/common file edits.

Pure-sync (no scan needed): the walker is called directly with a project node.
Modeled on ``test_indexer_dataset.py``.
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.indexer.functions.deck_template import (
    deck_template_asset_hash,
    extract_deck_template,
)
from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.fixtures.identity import resolve_id


def _mint(ref: FSRef) -> str:
    return resolve_id(SchemaRegistry.get("deck_template"), ref)


def _extract(ref: FSRef):
    return extract_deck_template(ref, _mint(ref))

# do not increase timeout without approval — these are pure-sync parses (<1s).
pytestmark = pytest.mark.timeout(5)


# ── fixtures ──────────────────────────────────────────────────────────────────

def _doc(metadata: dict | None = None, data: dict | None = None) -> str:
    """A two-section template JSON string: {"metadata": {...}, "data": {...}}."""
    return json.dumps({"metadata": metadata or {}, "data": data or {}})


def _seed_template(
    project: Path,
    slug: str,
    *,
    manifest: dict | None = None,
    manifest_data: dict | None = None,
    layouts: list[str] = (),
    common: dict[str, str] | None = None,
    media: dict[str, bytes] | None = None,
) -> Path:
    """Seed a deck template folder under ``agentic-assets/deck_template/<slug>/``."""
    tpl = project / "agentic-assets" / "deck_template" / slug
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
    for rel, text in (common or {}).items():
        path = tpl / "common" / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    for rel, blob in (media or {}).items():
        path = tpl / "media" / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)
    return tpl


# ── walker ────────────────────────────────────────────────────────────────────

def test_walker_emits_one_ref_per_template(tmp_path: Path) -> None:
    _seed_template(tmp_path, "A", layouts=["cover-centered"])
    _seed_template(tmp_path, "B", layouts=["agenda-list"])
    # A folder without template.json must be skipped.
    (tmp_path / "agentic-assets" / "deck_template" / "no-manifest").mkdir(parents=True)

    node = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD)
    refs = repo_assets_fn([node], IndexerOptions(verbose=False))

    assert len(refs) == 2
    assert all(r.record_type == RecordType.DECK_TEMPLATE for r in refs)
    assert sorted(Path(r.path).name for r in refs) == ["A", "B"]


def test_walker_no_templates_dir(tmp_path: Path) -> None:
    node = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD)
    assert repo_assets_fn([node], IndexerOptions(verbose=False)) == []


# ── id minting ────────────────────────────────────────────────────────────────

def test_gen_id_mints_v4_capsule_when_absent(tmp_path: Path) -> None:
    tpl = _seed_template(tmp_path, "mint")
    first = _mint(FSRef(tpl))
    second = _mint(FSRef(tpl))
    assert first == second  # idempotent (adopted from the json capsule)
    assert uuid.UUID(first).version == 4  # capsule-v4, not uuid5(path)


def test_gen_id_ignores_foreign_id_version(tmp_path: Path) -> None:
    """A non-v4/v5 id (e.g. a hand-authored v7) must be ignored, not adopted."""
    v7 = "018f5b2a-7c00-7000-8000-000000000000"  # version nibble = 7
    tpl = _seed_template(tmp_path, "v7", manifest={"id": v7})
    minted = _mint(FSRef(tpl))
    assert minted != v7
    assert uuid.UUID(minted).version == 4  # foreign id rejected → fresh v4


# ── extractor ─────────────────────────────────────────────────────────────────

def test_extract_happy_path(tmp_path: Path) -> None:
    tpl = _seed_template(
        tmp_path,
        "brand",
        manifest={
            "title": "Brand deck",
            "description": "corporate design language",
            "page_types": ["cover", "agenda", "closing"],
        },
        layouts=["cover-centered", "agenda-list", "closing-centered"],
        common={"tokens.css": ":root { --bg: #fff; }"},
    )
    records = _extract(FSRef(tpl))
    assert len(records) == 1
    rec = records[0]
    assert rec.type == RecordType.DECK_TEMPLATE
    assert rec.name == "Brand deck"
    meta = rec.meta_dict()["metadata"]
    # layouts come from disk (sorted stems), not the manifest
    assert meta["layouts"] == ["agenda-list", "closing-centered", "cover-centered"]
    assert meta["num_layouts"] == 3
    assert meta["page_types"] == ["cover", "agenda", "closing"]
    # layout names are searchable
    assert "agenda-list" in rec.content


def test_extract_defaults_name_to_slug(tmp_path: Path) -> None:
    tpl = _seed_template(tmp_path, "untitled", layouts=["blank-canvas"])
    rec = _extract(FSRef(tpl))[0]
    assert rec.name == "untitled"
    assert rec.meta_dict()["metadata"]["page_types"] == []


def test_extract_free_data_section_passthrough(tmp_path: Path) -> None:
    tpl = _seed_template(
        tmp_path, "d", manifest_data={"owner": "eran", "brand": "acme"}
    )
    meta = _extract(FSRef(tpl))[0].meta_dict()["metadata"]
    assert meta["data"] == {"owner": "eran", "brand": "acme"}


def test_extract_layouts_ignore_non_html(tmp_path: Path) -> None:
    tpl = _seed_template(tmp_path, "mix", layouts=["cover-centered"])
    (tpl / "layouts" / "notes.txt").write_text("not a layout", encoding="utf-8")
    (tpl / "layouts" / "partials").mkdir()
    meta = _extract(FSRef(tpl))[0].meta_dict()["metadata"]
    assert meta["layouts"] == ["cover-centered"]


def test_extract_non_template_folder_returns_empty(tmp_path: Path) -> None:
    plain = tmp_path / "agentic-assets" / "deck_template" / "no-manifest"
    plain.mkdir(parents=True)
    assert extract_deck_template(FSRef(plain), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") == []


def test_extract_id_agrees_with_gen_id(tmp_path: Path) -> None:
    """extract and gen_id must resolve the same id (capsule precedence)."""
    tpl = _seed_template(tmp_path, "agree", layouts=["cover-centered"])
    gen = _mint(FSRef(tpl))
    rec = _extract(FSRef(tpl))[0]
    assert rec.id == gen


# ── asset hash (folder freshness) ─────────────────────────────────────────────

def test_asset_hash_tracks_layout_and_common_edits(tmp_path: Path) -> None:
    tpl = _seed_template(
        tmp_path,
        "hash",
        layouts=["cover-centered"],
        common={"tokens.css": ":root {}"},
    )
    before = deck_template_asset_hash(FSRef(tpl))
    os.utime(tpl / "layouts" / "cover-centered.html", (before + 100, before + 100))
    after_layout = deck_template_asset_hash(FSRef(tpl))
    assert after_layout > before

    os.utime(tpl / "common" / "tokens.css", (after_layout + 100, after_layout + 100))
    assert deck_template_asset_hash(FSRef(tpl)) > after_layout


def test_asset_hash_tracks_media_add(tmp_path: Path) -> None:
    """Adding a media file bumps its parent dir's mtime — enough to re-index."""
    tpl = _seed_template(
        tmp_path, "media", layouts=["media-full-bleed"], media={"common/logo.png": b"\x89PNG"}
    )
    before = deck_template_asset_hash(FSRef(tpl))
    os.utime(tpl / "media" / "common", (before + 100, before + 100))
    assert deck_template_asset_hash(FSRef(tpl)) > before
