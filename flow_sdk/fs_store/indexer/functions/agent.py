"""Indexer function: <root> -> AGENT.

Emits AGENT for every `*.md` in `<root>/.claude/agents/`. Register on
USER_HOME_FOLDER, SYSTEM_ROOT, CWD_ROOT, REAL_PROJECT_CWD; scope inherits
via FSRef.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def agent_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        agents = Path(node.path) / ".claude" / "agents"
        if not agents.is_dir():
            continue
        for md in sorted(agents.glob("*.md")):
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(md, record_type=RecordType.AGENT, parent=node))
    return out
