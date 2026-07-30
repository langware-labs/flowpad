"""Walker + extractor + id mint for SPEC records.

Specs live at ``<project>/agentic-assets/spec/<name>/spec.md`` (markdown + YAML frontmatter).
Replaces the deleted ``SpecRecord`` subclass. Registration at module bottom.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


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
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415
    return mint_uuid(str(path.resolve()))


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
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415
    return adopt_entity_id(raw)  # validate-on-adopt (v4/v5) → else caller derives uuid5(path)


def spec_id(ref: FSRef) -> str:
    """Cheap id: prefer frontmatter ``id``; else uuid5(path)."""
    existing = _read_spec_frontmatter_id(ref._path)
    return existing if existing else _spec_id_from_path(ref._path)


def extract_spec(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a spec.md into a Record. Replaces ``SpecRecord._from_fsref_sync``.

    ``content`` is the body ONLY (frontmatter stripped) so the entity↔record
    round-trip is stable: ``Spec`` owns its main_ref, so ``_spec_default_body``
    re-renders ``frontmatter(id/title/spec_type) + content`` on every save — if
    ``content`` still carried the frontmatter, each save would accumulate a
    duplicate block. Title populates both ``name`` (generic folder/FTS) and
    ``title`` (the Spec entity's display field).
    """
    path = ref._path
    spec_uname = path.parent.name
    name = spec_uname
    spec_type = "plan"
    content = ""
    try:
        text = path.read_text(encoding="utf-8")
        from flow_sdk.capsules import strip_capsule_blocks  # noqa: PLC0415

        text = strip_capsule_blocks(text)
        content = _extract_body(text)  # body only — frontmatter stripped
        # Parse frontmatter with the YAML loader (not line-splitting) so quoted
        # values — e.g. a title containing a colon, which the renderer quotes —
        # round-trip cleanly.
        fm = _extract_frontmatter(text)
        if fm:
            fields = _yaml_load(fm) or {}
            if isinstance(fields, dict):
                if fields.get("title"):
                    name = str(fields["title"])
                if fields.get("spec_type"):
                    spec_type = str(fields["spec_type"])
    except OSError:
        pass
    rec = FSRecord(
        type=RecordType.SPEC,
        id=resolved_id,
        name=name,
        title=name,
        spec_type=spec_type,
        content=content,
    )
    rec.source_file = str(path)
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]
