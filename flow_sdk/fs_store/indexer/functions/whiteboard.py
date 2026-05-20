"""Indexer function: <root> -> WHITEBOARD.

Emits WHITEBOARD nodes for each directory in ``<root>/.claude/whiteboards/``
that contains a ``WHITE_BOARD.md`` file. Register on USER_HOME_FOLDER,
REAL_PROJECT_CWD, SYSTEM_ROOT, CWD_ROOT; scope inherits via FSRef.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def whiteboard_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        wb_dir = Path(node.path) / ".claude" / "whiteboards"
        if not wb_dir.is_dir():
            continue
        for entry in sorted(wb_dir.iterdir()):
            if not entry.is_dir():
                continue
            if not (entry / "WHITE_BOARD.md").exists():
                continue
            key = str(entry.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(entry, record_type=RecordType.WHITEBOARD, parent=node))
    return out
