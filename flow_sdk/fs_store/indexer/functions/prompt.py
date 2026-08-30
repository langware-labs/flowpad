"""Extractor + id mint for PROMPT records (docs/prompt-library.md).

Prompts live at ``<scope>/agentic-assets/prompt/<name>.md`` — YAML frontmatter for
metadata (``name``/``icon``/``color``/optional ``group_id``; the ``queue``
block is reserved for v1.1 enqueue flags and intentionally stays file-only),
body = the prompt text. Mirrors the SPEC recipe in ``spec.py``.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_frontmatter,
    _yaml_load,
)


def _prompt_id_from_path(path: Path) -> str:
    """UUID5 from resolved path — stable across rescans."""
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

    return mint_uuid(str(path.resolve()))


def _prompt_frontmatter(path: Path) -> dict:
    """Parsed frontmatter dict, or {} (never raises)."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    fm = _extract_frontmatter(text)
    if not fm:
        return {}
    fields = _yaml_load(fm)
    return fields if isinstance(fields, dict) else {}


def _read_prompt_frontmatter_id(path: Path) -> str | None:
    """Return a validated ``id`` from frontmatter, or None.

    Validate-on-adopt (entity-id policy): anything that isn't UUID v4/v5 is
    ignored so a hand-authored foreign id can never become an entity id —
    the caller derives the stable uuid5(path) instead.
    """
    raw = _prompt_frontmatter(path).get("id")
    from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415

    return adopt_entity_id(raw)


def prompt_id(ref: FSRef) -> str:
    """Cheap id: prefer frontmatter ``id``; else uuid5(path)."""
    existing = _read_prompt_frontmatter_id(ref._path)
    return existing if existing else _prompt_id_from_path(ref._path)
