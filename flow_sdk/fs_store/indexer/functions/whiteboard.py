"""Walker + extractor + id mint + asset-hash for WHITEBOARD records.

A whiteboard is a folder containing ``WHITE_BOARD.md`` (with YAML frontmatter)
and ``board.json`` (Excalidraw scene). Replaces the deleted
``WhiteboardRecord`` subclass.

Registration at module bottom. The ``default_body`` stub for "+ New
Whiteboard" creation is dropped; new whiteboards self-heal on first indexer
pass via ``whiteboard_gen_id`` which mints+writes an id into frontmatter.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

WHITE_BOARD_MD = "WHITE_BOARD.md"
BOARD_JSON = "board.json"

def whiteboard_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        wb_dir = Path(node.path) / ".claude" / "whiteboards"
        if not wb_dir.is_dir():
            continue
        for entry in sorted(wb_dir.iterdir()):
            if not entry.is_dir():
                continue
            if not (entry / WHITE_BOARD_MD).exists():
                continue
            key = str(entry.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(entry, record_type=RecordType.WHITEBOARD, parent=node))
    return out

# ── id helpers ───────────────────────────────────────────────────────────────

def _read_frontmatter_id_from_yaml(yaml_fields: dict) -> str | None:
    """Pick ``id`` (or legacy ``asset_id``) from a parsed frontmatter dict."""
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415
    raw = yaml_fields.get("id") or yaml_fields.get("asset_id")
    return adopt_entity_id(raw)  # validate-on-adopt (v4/v5) → else derive from name

def _resolve_whiteboard_name(yaml_fields: dict, folder_name: str) -> str:
    """Pick the whiteboard's display name: yaml.name first, else folder name."""
    yaml_name = yaml_fields.get("name")
    if isinstance(yaml_name, str) and yaml_name.strip():
        return yaml_name.strip()
    return folder_name.split("-@", 1)[-1] if "-@" in folder_name else folder_name

def _whiteboard_id_from_name(name: str) -> str:
    """Stable uuid5 derived from the whiteboard name."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{RecordType.WHITEBOARD}:{name}"))

def _load_whiteboard_fm(whiteboard_dir: Path) -> dict[str, Any]:
    """Load frontmatter from WHITE_BOARD.md, returning {} if absent."""
    try:
        text = (whiteboard_dir / WHITE_BOARD_MD).read_text(encoding="utf-8")
    except OSError:
        return {}
    fm = _extract_frontmatter(text)
    if not fm:
        return {}
    parsed = _yaml_load(fm)
    return parsed if isinstance(parsed, dict) else {}

def whiteboard_id(ref: FSRef) -> str:
    """Cheap id: prefer WHITE_BOARD.md frontmatter id; else uuid5(name)."""
    path = ref._path
    if path.is_dir():
        fm = _load_whiteboard_fm(path)
        fm_id = _read_frontmatter_id_from_yaml(fm)
        if fm_id:
            return fm_id
        wb_name = _resolve_whiteboard_name(fm, path.name)
        return _whiteboard_id_from_name(wb_name)
    return path.name.split("-@", 1)[-1] if "-@" in path.name else path.name

def whiteboard_gen_id(ref: FSRef) -> str:
    """Mint+write a stable id into WHITE_BOARD.md frontmatter (idempotent).

    Same shape as the deleted ``WhiteboardRecord.genId``. Preserves any
    existing id so DB rows keyed on that value stay valid.
    """
    path = ref._path
    if not path.is_dir():
        return whiteboard_id(ref)
    fm = _load_whiteboard_fm(path)
    existing = _read_frontmatter_id_from_yaml(fm)
    if existing:
        return existing
    wb_name = _resolve_whiteboard_name(fm, path.name)
    new_id = _whiteboard_id_from_name(wb_name)
    doc = path / WHITE_BOARD_MD
    if not doc.exists():
        return new_id
    try:
        text = doc.read_text(encoding="utf-8")
    except OSError:
        return new_id
    fm_text = _extract_frontmatter(text)
    body = _extract_body(text)
    fields: dict = {}
    if fm_text:
        parsed = _yaml_load(fm_text)
        if isinstance(parsed, dict):
            fields.update(parsed)
    merged = {"id": new_id, **{k: v for k, v in fields.items() if k not in ("id", "asset_id")}}
    try:
        doc.write_text(
            _render_frontmatter(merged) + "\n\n" + body + ("\n" if body and not body.endswith("\n") else ""),
            encoding="utf-8",
        )
    except OSError:
        pass
    return new_id

def whiteboard_asset_hash(ref: FSRef) -> float:
    """mtime across the whiteboard's inner content files.

    Default base implementation uses dir mtime, which doesn't update when a
    child file's content is edited. Whiteboards are folder-based, so this
    overrides to stat WHITE_BOARD.md + board.json instead.
    """
    base = ref._path
    ts = 0.0
    for name in (WHITE_BOARD_MD, BOARD_JSON):
        try:
            ts = max(ts, (base / name).stat().st_mtime)
        except OSError:
            pass
    return ts

# ── extractor ────────────────────────────────────────────────────────────────

def extract_whiteboard(ref: FSRef) -> list[FSRecord]:
    """Parse a whiteboard folder into a Record. Replaces ``WhiteboardRecord._from_fsref_sync``.

    Eagerly populates: id, name, description, content (name + description +
    body for FTS), body (markdown body for wiki indexing), and metadata (full
    frontmatter dict). The base ``Record.search_content`` / ``wiki_body``
    defaults read ``self.content`` / ``self.body``, so FTS + wiki work
    without subclass overrides.
    """
    path = ref._path
    fm = _load_whiteboard_fm(path) if path.is_dir() else {}
    wb_name = _resolve_whiteboard_name(fm, path.name)
    rec_id = _read_frontmatter_id_from_yaml(fm) or _whiteboard_id_from_name(wb_name)
    description = ""
    if isinstance(fm.get("description"), str):
        description = fm["description"]

    # Body = WHITE_BOARD.md without frontmatter. Used for wiki link extraction
    # and as the searchable body chunk.
    body = ""
    doc_path = path / WHITE_BOARD_MD
    try:
        text = doc_path.read_text(encoding="utf-8")
        body = _extract_body(text)
    except OSError:
        pass

    # Composite FTS body: name + description + WHITE_BOARD.md body. Excludes
    # board.json (the embedded files map blows up FTS).
    content_parts: list[str] = []
    if wb_name:
        content_parts.append(wb_name)
    if description:
        content_parts.append(description)
    if body:
        content_parts.append(body)
    content = "\n".join(content_parts) if content_parts else ""

    rec_kwargs: dict = {
        "type": RecordType.WHITEBOARD,
        "id": rec_id,
        "name": wb_name,
        "status": "active",
        "content": content,
        "body": body,
    }
    if description:
        rec_kwargs["description"] = description
    if fm:
        rec_kwargs["metadata"] = fm
    rec = FSRecord(**rec_kwargs)
    object.__setattr__(rec, "_asset_ref", FSRef(path.resolve()))
    return [rec]

# Type metadata now lives in flow_sdk/schema/type_info/whiteboard_info.py.
# This module provides the walker + slot functions only.
