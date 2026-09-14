"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.assets.frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType

_META_FIELDS: tuple[str, ...] = (
    "inputs_hash",
    "template_version",
    "prompt_version",
    "parent_ref",
    "file_count",
    "subfolder_count",
    "latest_process_ref",
)


def make_markdown_index_record(**kwargs: Any) -> FSRecord:
    """Create a bare ``Record`` for type ``MARKDOWN_INDEX``."""
    kwargs.setdefault("type", RecordType.MARKDOWN_INDEX)
    kwargs.setdefault("status", "active")
    kwargs.setdefault("asset_type", "markdown_index")
    return FSRecord(**kwargs)


def from_markdown(text: str, path: Path | None = None) -> FSRecord:
    """Parse a markdown string with YAML frontmatter into a MarkdownIndex Record.

    Mirrors ``MarkdownIndexRecord.from_markdown`` exactly — shares the same
    ``parse_markdown_text`` helper from the markdown indexer module.
    """
    from flow_sdk.api.api_types.identifier import adopt_entity_id, mint_uuid  # noqa: PLC0415
    from flow_sdk.assets.types.markdown_document import parse_markdown_text

    data = parse_markdown_text(text, path=path)
    data["asset_type"] = "markdown_index"

    fm_text = _extract_frontmatter(text)
    fields = _yaml_load(fm_text) if fm_text else {}

    # The rendered index.md carries its TypeId in frontmatter (`id:
    # markdown_index-<uuid>`). Strip our own type prefix, then validate-on-
    # adopt; anything non-conforming falls back to the same uuid5(path) the
    # TypeInfo.mint_id resolves — so re-indexing a rebuilt index.md updates the
    # original entity row instead of allocating a fresh id.
    raw_id = fields.get("id") or fields.get("asset_id")
    if isinstance(raw_id, str) and raw_id.startswith(f"{RecordType.MARKDOWN_INDEX.value}-"):
        raw_id = raw_id[len(f"{RecordType.MARKDOWN_INDEX.value}-"):]
    adopted = adopt_entity_id(raw_id)
    if adopted:
        data["id"] = adopted
    elif path is not None:
        data["id"] = mint_uuid(str(path.resolve()))

    rec = make_markdown_index_record(**data)
    for key in _META_FIELDS:
        if key in fields and fields[key] is not None:
            # FSRecord is a plain attr bag — meta_dict() picks up every
            # non-underscore attribute; no dirty bookkeeping exists.
            setattr(rec, key, fields[key])
    if path is not None:
        object.__setattr__(rec, "_asset_ref", FSRef(path))
    return rec
