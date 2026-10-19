"""Free-function helpers for MarkdownIndex records.

These replace the instance/class methods that used to live on
``MarkdownIndexRecord``:

  * Per-entity data-dir helpers
    (``entity_data_dir``, ``file_summaries_dir``, ``file_summary_path``)
  * ``from_markdown`` — parse a markdown string into a Record
  * ``default_body`` — stub index.md for a newly created entity
  * ``read_inputs_hash`` — convenience accessor for frontmatter inputs_hash

None of these touch the indexer.  They are consumed directly by the rebuild
AgenticProcess and by callers that previously held a ``MarkdownIndexRecord``
instance.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.assets.frontmatter import (
    _render_frontmatter,
)
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.record_paths import get_default_records_data_root
from flow_sdk.fs_store.record_types import RecordType

# ── Metadata fields carried in frontmatter ────────────────────────────────────




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


def entity_id_for_root(root: Path | str) -> str:
    """The MarkdownIndex entity id (bare uuid5) for a docs root path.

    One home for the ``typeid_for(root)`` → strip-prefix derivation, so the
    docs-graph routes, the `markdown_index` skill and docit's audit all resolve
    the SAME per-entity dir. The dir is instance-scoped, so a divergent copy of
    this derivation silently resolves an empty cache — and the only symptom is a
    full-price re-summarisation of the whole tree.
    """
    from flow_sdk.llm_index import typeid_for  # noqa: PLC0415 (avoid import cycle)

    return typeid_for(root).removeprefix("markdown_index-")


def summaries_dir_for_root(root: Path | str) -> Path:
    """The file-summary cache for a docs root, resolved from the root alone."""
    return file_summaries_dir(entity_id_for_root(root))


# ── Record constructors ───────────────────────────────────────────────────────








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


