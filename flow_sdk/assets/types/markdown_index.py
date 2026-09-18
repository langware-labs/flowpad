"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef


def markdown_index_identity_key(ref: FSRef | Path) -> str:
    return str(Path(getattr(ref, "_path", ref)).resolve())


def extract_markdown_index(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse an ``index.md`` file into a MARKDOWN_INDEX Record.

    Delegates to ``from_markdown`` in the operations module so the parse
    logic is not duplicated.
    """
    path = ref._path
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    from flow_sdk.assets.types.markdown_index_document import from_markdown
    rec = from_markdown(text, path=path)
    rec.id = resolved_id
    return [rec]
