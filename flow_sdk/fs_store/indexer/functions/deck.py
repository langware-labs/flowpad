"""Walker + extractor + id mint for DECK records.

A deck is a generated presentation — a folder under ``assets/decks/`` containing
a ``deck.json`` build record (the walker's marker file) and the assembled,
self-contained ``<name>.html``:

    assets/decks/<slug>/
      deck.json          # {"title", "template": "../../deck-templates/<name>", "slides": [...]}
      <name>.html        # self-contained Reveal deck (inlined CSS/JS + base64 media)

Provenance: the deck records which ``deck_template`` it was built from. The
extractor resolves ``deck.json["template"]`` (a relative path) to the sibling
template folder and reads that folder's ``.flow/id`` capsule (read-only) — so a
deck carries a ``template_ref`` edge to its template once the template is
indexed (else ``None``).

Type metadata lives in ``flow_sdk/schema/type_info/deck_type_info.py``; this
module provides the walker + slot functions only. Modeled on
``functions/deck_template.py``.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    folder_capsule_gen_id,
    read_folder_capsule_id,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

MANIFEST = "deck.json"


# ── walker ────────────────────────────────────────────────────────────────────

def deck_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """Emit one DECK FSRef per ``assets/decks/<slug>/`` folder containing a
    ``deck.json`` build record."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        root = Path(node.path) / "assets" / "decks"
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if not entry.is_dir():
                continue
            if not (entry / MANIFEST).is_file():
                continue
            key = str(entry.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(entry, record_type=RecordType.DECK, parent=node))
    return out


# ── id helpers ────────────────────────────────────────────────────────────────

def _load_manifest(deck_dir: Path) -> dict[str, Any]:
    """Read deck.json as a flat dict; ``{}`` when absent, malformed, or non-dict.

    Unlike template.json / dataset.json, deck.json is a flat build record
    (``{"title", "template", "slides"}``) authored by the skill — not a
    two-section metadata/data doc.
    """
    try:
        obj = json.loads((deck_dir / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return obj if isinstance(obj, dict) else {}


def _deck_id_from_path(path: Path) -> str:
    """Stable uuid5 derived from the resolved folder path."""
    return mint_uuid(f"{RecordType.DECK}:{path.resolve()}", namespace=uuid.NAMESPACE_DNS)


def deck_gen_id(ref: FSRef) -> str:
    """Resolve a deck's id. Idempotent.

    Precedence: the `.flow/id` capsule → a VALID `deck.json` `id` (adopted +
    backfilled) → a fresh random **v4** into the capsule. uuid5(path) is the
    read-only fallback.
    """
    path = ref._path
    if not path.is_dir():
        return _deck_id_from_path(path)
    manifest = _load_manifest(path)
    return folder_capsule_gen_id(path, manifest.get("id"))


# ── extractor ─────────────────────────────────────────────────────────────────

def _find_html(path: Path) -> str:
    """The deck's single output HTML file name, or "" if none.

    Skips ``*.mcp.html`` (interactive MCP-app files are never the deck). When
    several remain, prefer ``<foldername>.html``, else the first sorted.
    """
    htmls = sorted(
        p.name
        for p in path.iterdir()
        if p.is_file() and p.suffix == ".html" and not p.name.lower().endswith(".mcp.html")
    )
    if not htmls:
        return ""
    preferred = f"{path.name}.html"
    return preferred if preferred in htmls else htmls[0]


def _resolve_template_ref(deck_dir: Path, manifest: dict[str, Any]) -> str | None:
    """Resolve deck.json ``template`` (relative path) → the source deck_template's
    entity id, by reading the sibling template folder's ``.flow/id`` capsule.

    Read-only: returns ``None`` when there's no template ref, the folder is
    missing, or the template hasn't been indexed yet (no capsule). Never mints —
    the deck must not create the template's id.
    """
    rel = manifest.get("template")
    if not isinstance(rel, str) or not rel:
        return None
    try:
        tpl_dir = (deck_dir / rel).resolve()
    except OSError:
        return None
    if not tpl_dir.is_dir():
        return None
    return read_folder_capsule_id(tpl_dir)


def _slide_text(manifest: dict[str, Any]) -> str:
    """Flatten slide slot values into FTS-searchable text."""
    slides = manifest.get("slides")
    if not isinstance(slides, list):
        return ""
    parts: list[str] = []
    for slide in slides:
        if not isinstance(slide, dict):
            continue
        slots = slide.get("slots")
        if not isinstance(slots, dict):
            continue
        for value in slots.values():
            if isinstance(value, str):
                parts.append(value)
            elif isinstance(value, dict) and isinstance(value.get("html"), str):
                parts.append(value["html"])
    return "\n".join(parts)


def extract_deck(ref: FSRef) -> list[FSRecord]:
    """Parse a deck folder into a single FSRecord with denormalized build data."""
    path = ref._path
    if not path.is_dir() or not (path / MANIFEST).is_file():
        return []
    manifest = _load_manifest(path)

    deck_id = read_folder_capsule_id(path) or _deck_id_from_path(path)

    slides = manifest.get("slides")
    num_slides = len(slides) if isinstance(slides, list) else 0
    html_file = _find_html(path)
    template_ref = _resolve_template_ref(path, manifest)

    name = manifest.get("title") or path.name
    description = (
        manifest.get("description") if isinstance(manifest.get("description"), str) else ""
    )
    content = "\n".join(p for p in (name, description, _slide_text(manifest)) if p)

    metadata = {
        "title": name,
        "template_ref": template_ref,
        "num_slides": num_slides,
        "html_file": html_file,
    }

    rec_kwargs: dict[str, Any] = {
        "type": RecordType.DECK,
        "id": deck_id,
        "name": name,
        "status": "active",
        "content": content,
        "metadata": metadata,
    }
    if description:
        rec_kwargs["description"] = description
    rec = FSRecord(**rec_kwargs)
    object.__setattr__(rec, "_asset_ref", FSRef(path.resolve()))
    return [rec]


# ── asset hash (folder freshness) ─────────────────────────────────────────────

def deck_asset_hash(ref: FSRef) -> float:
    """mtime across the deck's build record + assembled HTML.

    A folder's own mtime doesn't move when a child's content is edited, so stat
    deck.json plus every ``*.html`` directly. Mirrors ``deck_template_asset_hash``.
    """
    base = ref._path
    ts = 0.0
    try:
        ts = max(ts, (base / MANIFEST).stat().st_mtime)
    except OSError:
        pass
    if base.is_dir():
        for child in base.iterdir():
            if child.is_file() and child.suffix == ".html":
                try:
                    ts = max(ts, child.stat().st_mtime)
                except OSError:
                    pass
    return ts
