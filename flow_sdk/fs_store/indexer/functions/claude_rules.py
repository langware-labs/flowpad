"""Indexer function: <root> -> CLAUDE_RULES.

Emits CLAUDE_RULES for every `*.md` in `<root>/.claude/rules/`. Register on
USER_HOME_FOLDER, REAL_PROJECT_CWD, CWD_ROOT; scope inherits via FSRef.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def claude_rules_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        rules = Path(node.path) / ".claude" / "rules"
        if not rules.is_dir():
            continue
        for md in sorted(rules.glob("*.md")):
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                FSRef(md, record_type=RecordType.CLAUDE_RULES, parent=node)
            )
    return out
