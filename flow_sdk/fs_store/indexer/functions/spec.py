"""Extractor + id mint for SPEC records.

Specs live at ``<project>/agentic-assets/spec/<name>/spec.md`` (markdown + YAML
frontmatter) and are discovered by the repo-assets walker. Replaces the deleted
``SpecRecord`` subclass.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_frontmatter,
    _yaml_load,
)


def _spec_id_from_path(path: Path) -> str:
    """UUID5 from resolved path — stable across rescans."""
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
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
    from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415
    return adopt_entity_id(raw)  # validate-on-adopt (v4/v5) → else caller derives uuid5(path)


def spec_id(ref: FSRef) -> str:
    """Cheap id: prefer frontmatter ``id``; else uuid5(path)."""
    existing = _read_spec_frontmatter_id(ref._path)
    return existing if existing else _spec_id_from_path(ref._path)


def derive_spec(data: dict, root: Path, header_raw: dict) -> None:
    """The name is the title, else the folder — a fact of the path, not the header."""
    data["name"] = data.get("title") or root.name
    data.setdefault("title", data["name"])
