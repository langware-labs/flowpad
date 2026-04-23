"""Indexer function: <root> -> COMMAND.

Emits COMMAND for every `*.md` in `<root>/.claude/commands/`. Legacy walker
only searches user (~/.claude/commands) and cwd (<cwd>/.claude/commands),
so register only on USER_HOME_FOLDER and CWD_ROOT. Scope inherits via FSRef.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def command_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        commands = Path(node.path) / ".claude" / "commands"
        if not commands.is_dir():
            continue
        for md in sorted(commands.glob("*.md")):
            if not md.is_file():
                continue
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                FSRef(md, record_type=RecordType.COMMAND, parent=node)
            )
    return out
