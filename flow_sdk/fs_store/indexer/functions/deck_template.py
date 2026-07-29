"""Extractor + id mint for DECK_TEMPLATE records.

A deck template is a folder under ``agentic-assets/deck_template/`` containing a
``template.json`` manifest (which is also the walker's marker file):

    assets/deck-templates/<slug>/
      template.json                # {"metadata": {id?, title, description, page_types, …}, "data": {…}}
      layouts/<layout name>.html   # one isolated <section> component per layout
      common/…                     # tokens.css / theme.css / deck.js shared by all layouts
      media/<common|layout name>/…
      vendor/reveal/               # vendored Reveal.js runtime

``template.json`` is a two-section document — ``{"metadata": {…}, "data": {…}}``
(the ``dataset.json`` convention). ``metadata`` holds flowpad-managed known
fields; ``data`` is a free, use-case-owned object.

Type metadata lives in ``flow_sdk/schema/type_info/deck_template_type_info.py``;
this module provides the walker + slot functions only. Modeled on
``functions/dataset.py``.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import adopt_entity_id, mint_uuid
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    read_folder_capsule_id,
)
from flow_sdk.fs_store.record_types import RecordType

MANIFEST = "template.json"
LAYOUTS_DIR = "layouts"
COMMON_DIR = "common"
MEDIA_DIR = "media"


# ── walker ────────────────────────────────────────────────────────────────────

def _load_manifest(template_dir: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Read template.json as ``(metadata, data)``; both ``{}`` when absent,
    malformed, or flat (the two-section structure is mandatory)."""
    try:
        obj = json.loads((template_dir / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}, {}
    if not isinstance(obj, dict):
        return {}, {}
    meta, data = obj.get("metadata"), obj.get("data")
    return (
        meta if isinstance(meta, dict) else {},
        data if isinstance(data, dict) else {},
    )


def _deck_template_id_from_path(path: Path) -> str:
    """Stable uuid5 derived from the resolved folder path."""
    return mint_uuid(
        f"{RecordType.DECK_TEMPLATE}:{path.resolve()}", namespace=uuid.NAMESPACE_DNS
    )


def deck_template_id_from_folder(ref: FSRef | Path) -> object | None:
    path = Path(getattr(ref, "_path", ref))
    cap = read_folder_capsule_id(path)
    if cap:
        return cap
    meta, _ = _load_manifest(path)

    return adopt_entity_id(meta.get("id"))


# ── extractor ─────────────────────────────────────────────────────────────────

def _scan_layouts(path: Path) -> list[str]:
    """Layout names = sorted ``layouts/*.html`` file stems."""
    layouts_dir = path / LAYOUTS_DIR
    if not layouts_dir.is_dir():
        return []
    return sorted(
        p.stem for p in layouts_dir.iterdir() if p.is_file() and p.suffix == ".html"
    )


def extract_deck_template(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a deck-template folder into a single FSRecord with denormalized
    layout data. The layouts on disk are the truth; the manifest's declared
    ``page_types`` ride along as semantic metadata."""
    path = ref._path
    if not path.is_dir() or not (path / MANIFEST).is_file():
        return []
    tpl_meta, tpl_data = _load_manifest(path)

    # Capsule wins (gen_id stamped it), else manifest id, else uuid5(path) — the
    # same precedence as the TypeInfo reader, so direct extraction agrees.
    layouts = _scan_layouts(path)
    raw_page_types = tpl_meta.get("page_types")
    page_types = (
        [str(p) for p in raw_page_types] if isinstance(raw_page_types, list) else []
    )

    name = tpl_meta.get("title") or path.name
    description = (
        tpl_meta.get("description")
        if isinstance(tpl_meta.get("description"), str)
        else ""
    )
    content = "\n".join(p for p in (name, description, *layouts) if p)

    metadata = {
        **tpl_meta,  # known template fields from the metadata section
        "layouts": layouts,
        "page_types": page_types,
        "num_layouts": len(layouts),
        "data": tpl_data,  # free template-level `data` section (use-case-owned)
    }
    # A manifest `id` is adopted (or ignored) into the authoritative record id
    # above; don't let a stale/foreign copy linger in stored metadata.
    metadata.pop("id", None)

    rec_kwargs: dict[str, Any] = {
        "type": RecordType.DECK_TEMPLATE,
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

def deck_template_asset_hash(ref: FSRef) -> float:
    """mtime across the template's authored content.

    A folder's own mtime does not move when a child file's *content* is edited,
    so stat the manifest plus every file under ``layouts/`` and ``common/``.
    ``media/`` can be arbitrarily large (video), so only its directory mtimes
    are statted — adding/removing media re-indexes; in-place binary edits are
    assumed not to happen. Mirrors ``dataset_asset_hash``.
    """
    base = ref._path
    ts = 0.0
    try:
        ts = max(ts, (base / MANIFEST).stat().st_mtime)
    except OSError:
        pass
    for subdir in (LAYOUTS_DIR, COMMON_DIR):
        inner_dir = base / subdir
        if not inner_dir.is_dir():
            continue
        for inner in inner_dir.rglob("*"):
            try:
                ts = max(ts, inner.stat().st_mtime)
            except OSError:
                pass
    media_dir = base / MEDIA_DIR
    if media_dir.is_dir():
        try:
            ts = max(ts, media_dir.stat().st_mtime)
        except OSError:
            pass
        for inner in media_dir.iterdir():
            try:
                ts = max(ts, inner.stat().st_mtime)
            except OSError:
                pass
    return ts
