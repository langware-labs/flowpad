"""Indexer function: USER_HOME_FOLDER -> PROJECT.

Given a user HOME directory node, enumerates encoded project directories
under <home>/.claude/projects/ and emits one PROJECT node per directory.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def claude_projects_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    for node in nodes:
        projects_dir = Path(node.path) / ".claude" / "projects"
        if not projects_dir.is_dir():
            continue
        for child in sorted(projects_dir.iterdir()):
            if child.is_dir():
                out.append(
                    FSRef(
                        child,
                        record_type=RecordType.PROJECT,
                        parent=node,
                    )
                )
    return out
