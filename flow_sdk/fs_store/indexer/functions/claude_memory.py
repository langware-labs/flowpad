"""Walker + extractor + id mint for CLAUDE_MEMORY records.

Memories live at ~/.claude/projects/<encoded>/memory/*.md — scoped to the
encoded project dir (the PROJECT node in our model), not the decoded cwd.

Replaces the deleted ``ClaudeMemoryRecord`` subclass.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def claude_memory_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    for node in nodes:
        mem_dir = Path(node.path) / "memory"
        if not mem_dir.is_dir():
            continue
        for md in sorted(mem_dir.glob("*.md")):
            out.append(
                FSRef(md, record_type=RecordType.CLAUDE_MEMORY, parent=node)
            )
    return out

def _read_memory_frontmatter_id(path: Path) -> str | None:
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

def _mem_id(path: Path) -> str:
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415
    return mint_uuid(str(path.resolve()))

def claude_memory_id(ref: FSRef) -> str:
    existing = _read_memory_frontmatter_id(ref._path)
    return existing if existing else _mem_id(ref._path)

def extract_claude_memory(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    from flow_sdk.fs_store.indexer.functions._claude_projects import _real_path_from_jsonl  # noqa: PLC0415

    md_path = ref._path
    # encoded project dir: md_path.parent is `memory/`, .parent.parent is the encoded dir
    project_dir = md_path.parent.parent
    encoded = project_dir.name
    real_path = _real_path_from_jsonl(project_dir)
    real = str(real_path) if real_path else "/" + encoded.lstrip("-").replace("-", "/")

    rec = FSRecord(
        RecordType.CLAUDE_MEMORY,
        resolved_id,
        name=md_path.stem,
        asset_type="memory",
        project_path=real,
    )
    rec.asset_ref = FSRef(md_path)
    return [rec]
