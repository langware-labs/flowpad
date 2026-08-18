"""Extractor + id mint for DECK records.

A deck is a generated presentation — a folder under ``agentic-assets/deck/`` containing
a ``deck.json`` build record (the walker's marker file) and the assembled,
self-contained ``<name>.html``:

    agentic-assets/deck/<slug>/
      deck.json          # {"title", "template": "../../deck_template/<name>", "slides": [...]}
      <name>.html        # self-contained Reveal deck (inlined CSS/JS + base64 media)

Provenance: the deck records which ``deck_template`` it was built from. The
extractor resolves ``deck.json["template"]`` (a relative path) to the sibling
template folder and asks the deck-template ``TypeInfo`` for its existing
filesystem identity (read-only) — so a deck carries a ``template_ref`` edge to
its template once an identity exists (else ``None``).

Type metadata lives in ``flow_sdk/schema/type_info/deck_type_info.py``; this
module provides the slot functions only. Modeled on
``functions/deck_template.py``.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    read_folder_capsule_id,
)
from flow_sdk.fs_store.record_types import RecordType

MANIFEST = "deck.json"


# ── manifest + id helpers ──────────────────────────────────────────────────────

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


def deck_id_from_folder(ref: FSRef | Path) -> object | None:
    path = Path(getattr(ref, "_path", ref))
    cap = read_folder_capsule_id(path)
    if cap:
        return cap
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415

    return adopt_entity_id(_load_manifest(path).get("id"))


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
    entity id through the deck-template type's identity backend.

    Read-only: returns ``None`` when there's no template ref, the folder is
    missing, or the template hasn't been indexed yet (no capsule). Never mints —
    the deck must not create the template's id.
    """
    rel = manifest.get("template")
    if not isinstance(rel, str) or not rel:
        return None
    tpl_dir = _resolve_template_dir(deck_dir, rel)
    if tpl_dir is None:
        return None
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(str(RecordType.DECK_TEMPLATE))
    if info is None:
        return None
    try:
        return info.mint_entity_id(FSRef(tpl_dir, record_type=RecordType.DECK_TEMPLATE))
    except Exception:
        return None


def _resolve_template_dir(deck_dir: Path, rel: str) -> Path | None:
    """The template folder ``rel`` points at, by relative path then by NAME.

    ``deck.json``'s ``template`` is a path relative to the deck folder, which made
    the provenance edge brittle: the repo-assets move retargeted decks from
    ``assets/decks/<slug>/`` to ``agentic-assets/deck/<slug>/``, so every existing
    deck's ``../../deck-templates/<name>`` now resolves to nothing and the edge
    would silently vanish.

    So: try the literal relative path, then fall back to the template family's
    canonical mount plus the ref's leaf name. Migrated decks self-heal without a
    manifest rewrite, and a hand-moved template keeps its edge.
    """
    try:
        literal = (deck_dir / rel).resolve()
        if literal.is_dir():
            return literal
    except OSError:
        pass

    from flow_sdk.fs_store.placement import AGENTIC_ASSETS_DIR  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    leaf = PurePosixPath(rel.replace("\\", "/")).name
    if not leaf or leaf in (".", ".."):
        return None
    # The template's mount comes from ITS OWN registered layout, so a change to
    # deck_template's asset_class/family is picked up here instead of drifting.
    tpl_info = SchemaRegistry.get(str(RecordType.DECK_TEMPLATE))
    subdir = getattr(tpl_info, "main_subdir", None) if tpl_info else None
    if not subdir:
        return None
    # Find the scope root by walking UP to the agentic-assets container rather
    # than indexing a fixed number of parents: ``parents[2]`` silently encodes
    # "<root>/agentic-assets/deck/<slug>" and breaks the moment nesting changes
    # (repo assets nest recursively — see repo_assets_fn).
    root = next((p.parent for p in deck_dir.parents if p.name == AGENTIC_ASSETS_DIR), None)
    if root is None:
        return None
    candidate = root / subdir / leaf
    return candidate if candidate.is_dir() else None


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


def extract_deck(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a deck folder into a single FSRecord with denormalized build data."""
    path = ref._path
    if not path.is_dir() or not (path / MANIFEST).is_file():
        return []
    manifest = _load_manifest(path)

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
        "id": resolved_id,
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
