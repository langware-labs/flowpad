"""Indexer functions: CLAUDE_MD discovery.

Two functions, split by *file layout* (not by scope — scope inherits via FSRef):

  claude_md_in_claude_subdir_fn
      <root>/.claude/CLAUDE.md, <root>/.claude/CLAUDE.local.md
      Register on USER_HOME_FOLDER (matches legacy ~/.claude/CLAUDE.md).

  claude_md_in_project_root_fn
      <root>/CLAUDE.md, <root>/CLAUDE.local.md, <root>/.claude/CLAUDE.md
      Register on REAL_PROJECT_CWD (matches legacy <project>/CLAUDE.md etc.).

Reproduces flow_sdk/fs_records/claude/claude_claude_md.py:indexer function.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def claude_md_in_claude_subdir_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """<root>/.claude/CLAUDE.md + .claude/CLAUDE.local.md."""
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


async def claude_md_in_project_root_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """<root>/CLAUDE.md, <root>/CLAUDE.local.md, <root>/.claude/CLAUDE.md."""
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
