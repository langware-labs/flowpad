"""Indexer functions: CLAUDE_MD discovery.

Two registrations:
  USER_HOME_FOLDER -> CLAUDE_MD  (home/.claude/CLAUDE.md + CLAUDE.local.md)
  REAL_PROJECT_CWD -> CLAUDE_MD  (project CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md)

Reproduces flow_sdk/fs_records/claude/claude_claude_md.py:_external_source_iter.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def claude_md_user_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """USER_HOME_FOLDER -> CLAUDE_MD. User scope: ~/.claude/CLAUDE{,.local}.md."""
    out: list[FSRef] = []
    for node in nodes:
        home = Path(node.path) / ".claude"
        for name in ("CLAUDE.md", "CLAUDE.local.md"):
            candidate = home / name
            if candidate.is_file():
                out.append(
                    FSRef(
                        candidate,
                        record_type=RecordType.CLAUDE_MD,
                        parent=node,
                    )
                )
    return out


async def claude_md_project_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """REAL_PROJECT_CWD -> CLAUDE_MD. Project scope: CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md."""
    out: list[FSRef] = []
    for node in nodes:
        for rel in ("CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"):
            candidate = Path(node.path) / rel
            if candidate.is_file():
                out.append(
                    FSRef(
                        candidate,
                        record_type=RecordType.CLAUDE_MD,
                        parent=node,
                    )
                )
    return out
