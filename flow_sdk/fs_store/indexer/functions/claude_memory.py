"""Walker + extractor + id mint for CLAUDE_MEMORY records.

Memories live at ~/.claude/projects/<encoded>/memory/*.md — scoped to the
encoded project dir (the PROJECT node in our model), not the decoded cwd.

Replaces the deleted ``ClaudeMemoryRecord`` subclass.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
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
    return str(raw).strip() if isinstance(raw, str) and raw.strip() else None

def _mem_id(path: Path) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))

def claude_memory_id(ref: FSRef) -> str:
    existing = _read_memory_frontmatter_id(ref._path)
    return existing if existing else _mem_id(ref._path)

def claude_memory_gen_id(ref: FSRef) -> str:
    existing = _read_memory_frontmatter_id(ref._path)
    if existing:
        return existing
    new_id = _mem_id(ref._path)
    try:
        text = ref._path.read_text(encoding="utf-8")
    except OSError:
        return new_id
    fm = _extract_frontmatter(text)
    body = _extract_body(text)
    fields: dict = {}
    if fm:
        parsed = _yaml_load(fm)
        if isinstance(parsed, dict):
            fields.update(parsed)
    merged = {"id": new_id, **{k: v for k, v in fields.items() if k not in ("id", "asset_id")}}
    try:
        ref._path.write_text(
            _render_frontmatter(merged) + "\n\n" + body + ("\n" if body and not body.endswith("\n") else ""),
            encoding="utf-8",
        )
    except OSError:
        pass
    return new_id

def extract_claude_memory(ref: FSRef) -> list[FSRecord]:
    from flow_sdk.fs_store.indexer.functions._claude_projects import _real_path_from_jsonl  # noqa: PLC0415

    md_path = ref._path
    # encoded project dir: md_path.parent is `memory/`, .parent.parent is the encoded dir
    project_dir = md_path.parent.parent
    encoded = project_dir.name
    real_path = _real_path_from_jsonl(project_dir)
    real = str(real_path) if real_path else "/" + encoded.lstrip("-").replace("-", "/")

    mem_id = claude_memory_id(ref)
    rec = FSRecord(
        RecordType.CLAUDE_MEMORY,
        mem_id,
        name=md_path.stem,
        asset_type="memory",
        project_path=real,
    )
    rec.asset_ref = FSRef(md_path)
    return [rec]
