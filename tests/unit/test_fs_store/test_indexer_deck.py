"""Indexer tests for the DECK type.

Covers the slot functions end-to-end:
- ``repo_assets_fn`` emits one FSRef per ``agentic-assets/deck/<slug>/`` folder carrying
  a ``deck.json`` build record.
- ``extract_deck`` denormalizes num_slides / html_file and resolves the
  ``template_ref`` provenance edge from the sibling template's ``.flow/id`` capsule.
- the json capsule carries the id (a manifest id is not a carrier).
- ``deck_asset_hash`` tracks deck.json + the assembled HTML.

Pure-sync; the walker/slot functions are called directly. Modeled on
``test_indexer_deck_template.py``.
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import pytest

from flow_sdk.capsules import CapsuleData
from flow_sdk.capsules.folder import FolderCapsule
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.indexer.functions.deck import (
    deck_asset_hash,
    extract_deck,
)
from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.fixtures.identity import resolve_id


def _mint(ref: FSRef) -> str:
    return resolve_id(SchemaRegistry.get("deck"), ref)


def _extract(ref: FSRef):
    return extract_deck(ref, _mint(ref))

# do not increase timeout without approval — these are pure-sync parses (<1s).
pytestmark = pytest.mark.timeout(5)


def _seed_deck(
    project: Path,
    slug: str,
    *,
    manifest: dict | None = None,
    html_name: str | None = None,
) -> Path:
    deck = project / "agentic-assets" / "deck" / slug
    deck.mkdir(parents=True)
    (deck / "deck.json").write_text(json.dumps(manifest or {"title": slug, "slides": []}), encoding="utf-8")
    (deck / (html_name or f"{slug}.html")).write_text("<html><body>deck</body></html>", encoding="utf-8")
    return deck


def _seed_template(project: Path, slug: str, *, capsule_id: str | None = None) -> Path:
    tpl = project / "agentic-assets" / "deck_template" / slug
    (tpl / "layouts").mkdir(parents=True)
    (tpl / "template.json").write_text(json.dumps({"metadata": {"title": slug}, "data": {}}), encoding="utf-8")
    if capsule_id:
        FolderCapsule(tpl).write("identity", CapsuleData(1, {"id": capsule_id}))
    return tpl


# ── walker ────────────────────────────────────────────────────────────────────

def test_walker_emits_one_ref_per_deck(tmp_path: Path) -> None:
    _seed_deck(tmp_path, "A")
    _seed_deck(tmp_path, "B")
    (tmp_path / "agentic-assets" / "deck" / "no-manifest").mkdir(parents=True)  # skipped

    node = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD)
    refs = repo_assets_fn([node], IndexerOptions(verbose=False))

    assert len(refs) == 2
    assert all(r.record_type == RecordType.DECK for r in refs)
    assert sorted(Path(r.path).name for r in refs) == ["A", "B"]


def test_walker_no_decks_dir(tmp_path: Path) -> None:
    node = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD)
    assert repo_assets_fn([node], IndexerOptions(verbose=False)) == []


# ── id minting ────────────────────────────────────────────────────────────────

def test_gen_id_mints_v4_capsule_when_absent(tmp_path: Path) -> None:
    deck = _seed_deck(tmp_path, "mint")
    first = _mint(FSRef(deck))
    second = _mint(FSRef(deck))
    assert first == second
    assert uuid.UUID(first).version == 4


# ── extractor ─────────────────────────────────────────────────────────────────

def test_extract_denormalizes_slides_and_html(tmp_path: Path) -> None:
    deck = _seed_deck(tmp_path, "brand", manifest={
        "title": "Brand Deck",
        "description": "a pitch",
        "slides": [
            {"layout": "cover-centered", "slots": {"title": "Hello"}},
            {"layout": "closing-centered", "slots": {"title": "Thanks"}},
        ],
    })
    rec = _extract(FSRef(deck))[0]
    assert rec.type == RecordType.DECK
    assert rec.name == "Brand Deck"
    m = rec.meta_dict()["metadata"]
    assert m["num_slides"] == 2
    assert m["html_file"] == "brand.html"
    # slide slot text is searchable
    assert "Hello" in rec.content and "Thanks" in rec.content


def test_extract_prefers_foldername_html(tmp_path: Path) -> None:
    deck = _seed_deck(tmp_path, "pick", html_name="pick.html")
    (deck / "other.html").write_text("<html></html>", encoding="utf-8")
    assert _extract(FSRef(deck))[0].meta_dict()["metadata"]["html_file"] == "pick.html"


def test_extract_ignores_mcp_html(tmp_path: Path) -> None:
    deck = tmp_path / "agentic-assets" / "deck" / "mcp"
    deck.mkdir(parents=True)
    (deck / "deck.json").write_text(json.dumps({"title": "M", "slides": []}), encoding="utf-8")
    (deck / "picker.mcp.html").write_text("<html></html>", encoding="utf-8")
    (deck / "mcp.html").write_text("<html></html>", encoding="utf-8")
    assert _extract(FSRef(deck))[0].meta_dict()["metadata"]["html_file"] == "mcp.html"


def test_extract_non_deck_folder_returns_empty(tmp_path: Path) -> None:
    plain = tmp_path / "agentic-assets" / "deck" / "empty"
    plain.mkdir(parents=True)
    assert extract_deck(FSRef(plain), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") == []


# ── provenance (template_ref) ──────────────────────────────────────────────────

def test_template_ref_resolves_from_capsule(tmp_path: Path) -> None:
    tpl_id = str(uuid.uuid4())
    _seed_template(tmp_path, "aurora", capsule_id=tpl_id)
    deck = _seed_deck(tmp_path, "pitch", manifest={
        "title": "Pitch", "template": "../../deck_template/aurora", "slides": [],
    })
    assert _extract(FSRef(deck))[0].meta_dict()["metadata"]["template_ref"] == tpl_id


def test_template_ref_none_when_template_uncapsuled(tmp_path: Path) -> None:
    _seed_template(tmp_path, "aurora")  # no capsule written
    deck = _seed_deck(tmp_path, "pitch", manifest={
        "title": "Pitch", "template": "../../deck_template/aurora", "slides": [],
    })
    assert _extract(FSRef(deck))[0].meta_dict()["metadata"]["template_ref"] is None


def test_template_ref_none_when_no_template_field(tmp_path: Path) -> None:
    deck = _seed_deck(tmp_path, "solo", manifest={"title": "Solo", "slides": []})
    assert _extract(FSRef(deck))[0].meta_dict()["metadata"]["template_ref"] is None


# ── extract/gen agreement (production order: gen stamps capsule, extract reads it) ──

def test_extract_id_agrees_with_gen_id(tmp_path: Path) -> None:
    deck = _seed_deck(tmp_path, "agree")
    gen = _mint(FSRef(deck))
    assert _extract(FSRef(deck))[0].id == gen


# ── asset hash ─────────────────────────────────────────────────────────────────

def test_asset_hash_tracks_manifest_and_html_edits(tmp_path: Path) -> None:
    deck = _seed_deck(tmp_path, "hash")
    before = deck_asset_hash(FSRef(deck))
    os.utime(deck / "deck.json", (before + 100, before + 100))
    after = deck_asset_hash(FSRef(deck))
    assert after > before
    os.utime(deck / "hash.html", (after + 100, after + 100))
    assert deck_asset_hash(FSRef(deck)) > after
