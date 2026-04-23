"""Indexer functions: CLAUDE_RULES discovery.

Two registrations:
  USER_HOME_FOLDER -> CLAUDE_RULES  (~/.claude/rules/*.md)
  REAL_PROJECT_CWD -> CLAUDE_RULES  (<cwd>/.claude/rules/*.md)

Reproduces flow_sdk/fs_records/claude/claude_rules.py:_external_source_iter.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def claude_rules_user_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """USER_HOME_FOLDER -> CLAUDE_RULES. User scope."""
    out: list[FSRef] = []
    for node in nodes:
        rules = Path(node.path) / ".claude" / "rules"
        if not rules.is_dir():
            continue
        for md in sorted(rules.glob("*.md")):
            out.append(
                FSRef(md, record_type=RecordType.CLAUDE_RULES, parent=node)
            )
    return out


async def claude_rules_project_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """REAL_PROJECT_CWD -> CLAUDE_RULES. Project scope."""
    out: list[FSRef] = []
    for node in nodes:
        rules = Path(node.path) / ".claude" / "rules"
        if not rules.is_dir():
            continue
        for md in sorted(rules.glob("*.md")):
            out.append(
                FSRef(md, record_type=RecordType.CLAUDE_RULES, parent=node)
            )
    return out
