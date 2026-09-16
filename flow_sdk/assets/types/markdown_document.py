"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.assets.frontmatter import _extract_body, _extract_frontmatter, _yaml_load
from flow_sdk.assets.types.markdown import _derive


def _markdown_id_from_path(path: Path) -> str:
    """Transitional/read-only fallback key — the stable uuid5(path) value.

    No longer the miss behavior (``TypeInfo.mint_id`` persists a fresh v4).
    Survives only as the ``parse_markdown_text`` read-side
    derive for a not-yet-stamped file.
    """
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

    return mint_uuid(str(path.resolve()))


def parse_markdown_text(text: str, path: Path | None = None) -> dict[str, Any]:
    """Parse a markdown string with YAML frontmatter into a fields dict — the
    same header (``MarkdownSpec``) and the same derivation the serializer
    applies, over a STRING. Public for ``operations.markdown_index.from_markdown``."""
    from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415
    from flow_sdk.capsules import strip_capsule_blocks  # noqa: PLC0415
    from flow_sdk.schema.data_spec.markdown_spec import MarkdownSpec

    text = strip_capsule_blocks(text)
    fm_text = _extract_frontmatter(text)
    fields = _yaml_load(fm_text) if fm_text else {}
    fields = fields if isinstance(fields, dict) else {}
    data: dict[str, Any] = MarkdownSpec.model_validate(fields).model_dump(exclude_none=True, exclude={"body"})
    data["body"] = _extract_body(text)
    _derive(data, path or Path("Untitled.md"), fields, titled=True)
    # Validate-on-adopt (v4/v5 only) — a foreign/hand-authored id is never
    # adopted; derive the stable uuid5(path) instead.
    asset_id = adopt_entity_id(fields.get("id"))
    if not asset_id and path is not None:
        asset_id = _markdown_id_from_path(path)
    if asset_id:
        data["id"] = asset_id
    return data
