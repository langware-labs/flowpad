"""MarkdownIndexRecord — single-file `index.md` entity backed by a generated
folder index.

Frontmatter carries entity metadata (inputs_hash, parent_ref, template_version,
prompt_version, file_count, subfolder_count, latest_process_ref).
The markdown body is the human-readable index emitted by the rebuild agent.

System entity — not crawled by the indexer and not surfaced in the records
browser. The rebuild AgenticProcess is the only writer.

Per-entity internal data (LLM summary cache, future index.md.json sidecar)
lives in the flowpad per-instance records data dir, scoped by entity id:

    <records_data_root>/markdown_index/<entity_id>/file_summaries/<H>.summary.md

User docs are touched only at the asset_ref location (`index.md`).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_store import RecordType
from flow_sdk.fs_store.record import get_default_records_data_root

from ._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)
from .markdown_record import MarkdownRecord


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


class MarkdownIndexRecord(MarkdownRecord):
    """Record for a generated ``index.md`` file (Merkle-tree folder index).

    Inherits frontmatter parsing + file I/O from ``MarkdownRecord``; specialises
    type, parses extra metadata fields, and exposes per-entity data-dir helpers
    used by the rebuild agent.
    """

    _record_type: ClassVar[str] = RecordType.MARKDOWN_INDEX
    _indexed_by_default: ClassVar[bool] = False  # system entity — not crawled by `flow record index`
    _browseable: ClassVar[bool] = False          # not surfaced in records browser
    _creatable: ClassVar[bool] = True            # created by the rebuild AgenticProcess
    _icon: ClassVar[str] = "ListTree"
    index_fields: ClassVar[list[str]] = [
        "title",
        "parent_ref",
        "inputs_hash",
        "vault_root",
        "parent_path",
    ]

    _main_subdir: ClassVar[str] = "docs"
    _main_layout: ClassVar[str] = "file"

    _META_FIELDS: ClassVar[tuple[str, ...]] = (
        "inputs_hash",
        "template_version",
        "prompt_version",
        "parent_ref",
        "file_count",
        "subfolder_count",
        "latest_process_ref",
    )

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("type", RecordType.MARKDOWN_INDEX)
        kwargs.setdefault("asset_type", "markdown_index")
        super().__init__(**kwargs)

    @classmethod
    def from_markdown(cls, text: str, path: Path | None = None) -> "MarkdownIndexRecord":
        rec = super().from_markdown(text, path=path)
        fm_text = _extract_frontmatter(text)
        fields = _yaml_load(fm_text) if fm_text else {}
        for key in cls._META_FIELDS:
            if key in fields and fields[key] is not None:
                object.__setattr__(rec, key, fields[key])
                dirty = object.__getattribute__(rec, "_dirty_keys")
                dirty.add(key)
        object.__setattr__(rec, "asset_type", "markdown_index")
        return rec  # type: ignore[return-value]

    def default_body(self, entity) -> "str | None":
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

    # ── Per-entity data dir helpers ────────────────────────────────────────────
    # Path scoping lives at module level (`entity_data_dir(id)`, `file_summaries_dir(id)`,
    # `file_summary_path(id, hash)`). These instance methods just bind the entity's id.

    def entity_data_dir(self) -> Path | None:
        eid = getattr(self, "id", None)
        return entity_data_dir(eid) if eid else None

    def file_summaries_dir(self) -> Path | None:
        eid = getattr(self, "id", None)
        return file_summaries_dir(eid) if eid else None

    def file_summary_path(self, content_hash: str) -> Path | None:
        eid = getattr(self, "id", None)
        return file_summary_path(eid, content_hash) if eid else None

    def read_inputs_hash(self) -> str:
        """Return the frontmatter ``inputs_hash`` (empty string if unset)."""
        return str(getattr(self, "inputs_hash", "") or "")

    def write_frontmatter_fields(self, updates: dict[str, Any]) -> None:
        """Rewrite the on-disk ``index.md`` frontmatter merging ``updates``.

        Body is preserved verbatim. Caller is responsible for sync_to_db after.
        """
        ar = self._asset_ref if hasattr(self, "_asset_ref") else None
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
            object.__setattr__(self, key, value)
            dirty = object.__getattribute__(self, "_dirty_keys")
            dirty.add(key)
