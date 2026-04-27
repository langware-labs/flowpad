"""Indexer function: <root> -> WORKFLOW.

Emits WORKFLOW for every `*.md` in `<root>/.claude/workflows/`. Register on
USER_HOME_FOLDER, REAL_PROJECT_CWD, CWD_ROOT; scope inherits via FSRef.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def workflow_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        workflows = Path(node.path) / ".claude" / "workflows"
        if not workflows.is_dir():
            continue
        for md in sorted(workflows.glob("*.md")):
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                FSRef(md, record_type=RecordType.WORKFLOW, parent=node)
            )
    return out
