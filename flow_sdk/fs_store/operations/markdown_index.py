"""Free-function helpers for MarkdownIndex records.

These replace the instance/class methods that used to live on
``MarkdownIndexRecord``:

  * Per-entity data-dir helpers
    (``entity_data_dir``, ``file_summaries_dir``, ``file_summary_path``)
  * ``from_markdown`` — parse a markdown string into a Record
  * ``write_frontmatter_fields`` — rewrite on-disk frontmatter merging updates
  * ``default_body`` — stub index.md for a newly created entity
  * ``read_inputs_hash`` — convenience accessor for frontmatter inputs_hash

None of these touch the indexer.  They are consumed directly by the rebuild
AgenticProcess and by callers that previously held a ``MarkdownIndexRecord``
instance.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_paths import get_default_records_data_root
from flow_sdk.fs_store.record_types import RecordType

from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)

# ── Metadata fields carried in frontmatter ────────────────────────────────────

_META_FIELDS: tuple[str, ...] = (
    "inputs_hash",
    "template_version",
    "prompt_version",
    "parent_ref",
    "file_count",
    "subfolder_count",
    "latest_process_ref",
)


# ── Per-entity data-dir helpers ───────────────────────────────────────────────


def entity_data_dir(entity_id: str) -> Path:
    """Per-entity data dir under flowpad's records-data root.

    Holds the LLM summary cache (and future index.md.json sidecar). Lives
    inside the flowpad instance structure — never inside user docs.
    """
    if not entity_id:
        raise ValueError("entity_id is required to resolve markdown_index data dir")
    return get_default_records_data_root() / "markdown_index" / entity_id


def file_summaries_dir(entity_id: str) -> Path:
    return entity_data_dir(entity_id) / "file_summaries"


def file_summary_path(entity_id: str, content_hash: str) -> Path:
    return file_summaries_dir(entity_id) / f"{content_hash}.summary.md"


# ── Record constructors ───────────────────────────────────────────────────────


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
    from flow_sdk.fs_store.indexer.functions.markdown import parse_markdown_text  # noqa: PLC0415

    data = parse_markdown_text(text, path=path)
    data["asset_type"] = "markdown_index"
    rec = make_markdown_index_record(**data)

    fm_text = _extract_frontmatter(text)
    fields = _yaml_load(fm_text) if fm_text else {}
    for key in _META_FIELDS:
        if key in fields and fields[key] is not None:
            object.__setattr__(rec, key, fields[key])
            dirty = object.__getattribute__(rec, "_dirty_keys")
            dirty.add(key)
    if path is not None:
        object.__setattr__(rec, "_asset_ref", FSRef(path))
    return rec


def default_body(entity: Any) -> str:
    """Stub index.md with full frontmatter — replaced by the rebuild agent."""
    name = (getattr(entity, "name", None) or "").strip() or "Index"
    fields = {
        "id": entity.id,
        "type": RecordType.MARKDOWN_INDEX.value,
        "title": name,
        "inputs_hash": "",
        "template_version": 1,
        "prompt_version": 1,
        "parent_ref": "",
        "file_count": 0,
        "subfolder_count": 0,
        "latest_process_ref": "",
    }
    return _render_frontmatter(fields) + f"\n# {name}\n\n## Self-Summary\n> (Pending first rebuild.)\n"


def read_inputs_hash(rec: FSRecord) -> str:
    """Return the frontmatter ``inputs_hash`` (empty string if unset)."""
    return str(getattr(rec, "inputs_hash", "") or "")


def write_frontmatter_fields(rec: FSRecord, updates: dict[str, Any]) -> None:
    """Rewrite the on-disk ``index.md`` frontmatter merging ``updates``.

    Body is preserved verbatim. Caller is responsible for sync_to_db after.
    """
    ar = rec._asset_ref if hasattr(rec, "_asset_ref") else None
    if ar is None or not ar.exists():
        return
    text = Path(ar._path).read_text(encoding="utf-8")
    fm = _extract_frontmatter(text)
    body = _extract_body(text)
    parsed: dict[str, Any] = {}
    if fm:
        loaded = _yaml_load(fm)
        if isinstance(loaded, dict):
            parsed.update(loaded)
    parsed.update(updates)
    Path(ar._path).write_text(
        _render_frontmatter(parsed)
        + "\n\n"
        + body
        + ("\n" if body and not body.endswith("\n") else ""),
        encoding="utf-8",
    )
    for key, value in updates.items():
        object.__setattr__(rec, key, value)
        dirty = object.__getattribute__(rec, "_dirty_keys")
        dirty.add(key)
