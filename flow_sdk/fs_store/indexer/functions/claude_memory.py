"""Indexer function: PROJECT -> CLAUDE_MEMORY.

Reproduces flow_sdk/fs_records/claude/claude_memory.py:indexer function.
Memories live at ~/.claude/projects/<encoded>/memory/*.md — scoped to the
encoded project dir (the PROJECT node in our model), not the decoded cwd.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def claude_memory_fn(
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
