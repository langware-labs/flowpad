"""Walker + extractor + id mint for SPEC records.

Specs live at ``<project>/specs/<name>/spec.md`` (markdown + YAML frontmatter).
Replaces the deleted ``SpecRecord`` subclass. Registration at module bottom.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)


def spec_project_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        specs_root = Path(node.path) / "specs"
        if not specs_root.is_dir():
            continue
        for spec_dir in sorted(specs_root.iterdir()):
            md = spec_dir / "spec.md"
            if not md.is_file():
                continue
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                FSRef(md, record_type=RecordType.SPEC, parent=node)
            )
    return out


def _spec_id_from_path(path: Path) -> str:
    """UUID5 from resolved path — stable across rescans."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))


def _read_spec_frontmatter_id(path: Path) -> str | None:
    """Return ``id`` (or legacy ``asset_id``) from frontmatter, or None."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm = _extract_frontmatter(text)
    if not fm:
        return None
    fields = _yaml_load(fm) or {}
    raw = fields.get("id") or fields.get("asset_id")
    return str(raw).strip() if isinstance(raw, str) and raw.strip() else None


def spec_id(ref: FSRef) -> str:
    """Cheap id: prefer frontmatter ``id``; else uuid5(path)."""
    existing = _read_spec_frontmatter_id(ref._path)
    return existing if existing else _spec_id_from_path(ref._path)


def spec_gen_id(ref: FSRef) -> str:
    """Mint+write a stable id into the frontmatter (idempotent).

    Preserves any existing derived id so DB rows keyed on uuid5(path) stay
    valid. Same shape as the deleted ``SpecRecord.genId``.
    """
    existing = _read_spec_frontmatter_id(ref._path)
    if existing:
        return existing
    new_id = _spec_id_from_path(ref._path)
    try:
        text = ref._path.read_text(encoding="utf-8")
    except OSError:
        return new_id
    fm = _extract_frontmatter(text)
    body = _extract_body(text)
    fields: dict = {}
    if fm:
        parsed = _yaml_load(fm)
        if isinstance(parsed, dict):
            fields.update(parsed)
    merged = {"id": new_id, **{k: v for k, v in fields.items() if k not in ("id", "asset_id")}}
    try:
        ref._path.write_text(
            _render_frontmatter(merged) + "\n\n" + body + ("\n" if body and not body.endswith("\n") else ""),
            encoding="utf-8",
        )
    except OSError:
        pass
    return new_id


def extract_spec(ref: FSRef) -> list[FSRecord]:
    """Parse a spec.md into a Record. Replaces ``SpecRecord._from_fsref_sync``."""
    path = ref._path
    spec_uname = path.parent.name
    name = spec_uname
    spec_type = "plan"
    content = ""
    try:
        text = path.read_text(encoding="utf-8")
        content = text
        if text.startswith("---"):
            end = text.find("---", 3)
            if end != -1:
                fm_text = text[3:end].strip()
                for line in fm_text.splitlines():
                    if line.startswith("title:"):
                        name = line.split(":", 1)[1].strip().strip('"')
                    elif line.startswith("spec_type:"):
                        spec_type = line.split(":", 1)[1].strip()
    except OSError:
        pass
    rec_id = _read_spec_frontmatter_id(path) or _spec_id_from_path(path)
    rec = FSRecord(
        type=RecordType.SPEC,
        id=rec_id,
        name=name,
        spec_type=spec_type,
        content=content,
    )
    rec.source_file = str(path)
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]
