"""Tests for ``Deck.from_fs_ref`` — the generic, DB-free on-disk loader.

Asserts the typed ``Deck`` loaded via ``from_fs_ref`` matches the indexer cold
path (id, template_ref, num_slides, html_file, asset_ref). Modeled on
``test_deck_template_from_fs_ref.py``.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.deck import Deck
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions._folder_capsule import write_folder_capsule_id
from flow_sdk.fs_store.indexer.functions.deck import extract_deck
from flow_sdk.fs_store.schema_registry import SchemaRegistry

# do not increase timeout without approval — these are pure-sync parses (<1s).
pytestmark = pytest.mark.timeout(5)


def _seed_deck(project: Path, slug: str, *, manifest: dict | None = None) -> Path:
    deck = project / "assets" / "decks" / slug
    deck.mkdir(parents=True)
    (deck / "deck.json").write_text(json.dumps(manifest or {"title": slug, "slides": []}), encoding="utf-8")
    (deck / f"{slug}.html").write_text("<html><body>deck</body></html>", encoding="utf-8")
    return deck


def test_returns_typed_deck(tmp_path: Path) -> None:
    deck = _seed_deck(tmp_path, "d")
    loaded = Deck.from_fs_ref(FSRef(deck))
    assert type(loaded) is Deck


def test_non_deck_folder_returns_none(tmp_path: Path) -> None:
    plain = tmp_path / "not_a_deck"
    plain.mkdir()
    (plain / "readme.txt").write_text("hi", encoding="utf-8")
    assert Deck.from_fs_ref(FSRef(plain)) is None


def test_indexer_compatible_all_fields(tmp_path: Path) -> None:
    tpl_id = str(uuid.uuid4())
    tpl = tmp_path / "assets" / "deck-templates" / "aurora"
    tpl.mkdir(parents=True)
    (tpl / "template.json").write_text(json.dumps({"metadata": {}, "data": {}}), encoding="utf-8")
    write_folder_capsule_id(tpl, tpl_id)

    deck = _seed_deck(tmp_path, "pitch", manifest={
        "title": "Pitch", "description": "investor deck",
        "template": "../../deck-templates/aurora",
        "slides": [{"layout": "cover-centered", "slots": {"title": "Hi"}}],
    })
    ref = FSRef(deck)
    gen = SchemaRegistry.get("deck").mint_entity_id(ref)
    loaded = Deck.from_fs_ref(ref)
    rec = extract_deck(ref, gen)[0]
    m = rec.meta_dict()["metadata"]

    assert loaded.id == gen == rec.id
    assert loaded.title == "Pitch"
    assert loaded.description == "investor deck"
    assert loaded.template_ref == tpl_id == m["template_ref"]
    assert loaded.num_slides == 1 == m["num_slides"]
    assert loaded.html_file == "pitch.html" == m["html_file"]
    assert loaded.asset_ref == str(Path(deck).resolve())


def test_determinism_stable_ids(tmp_path: Path) -> None:
    deck = _seed_deck(tmp_path, "det")
    a = Deck.from_fs_ref(FSRef(deck))
    b = Deck.from_fs_ref(FSRef(deck))
    assert a.id == b.id
