"""Indexer function: USER_HOME_FOLDER -> COMMAND.

Reproduces flow_sdk/fs_records/claude/claude_command.py:_command_search_dirs
+ discover_iter. Commands live only at user-level ~/.claude/commands/*.md
and cwd-level .claude/commands/*.md — no per-project iter_claude_project_paths()
walk in the legacy code.
"""

from __future__ import annotations

import os
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def _emit_commands_from(
    commands_dir: Path,
    parent: FSRef,
    out: list[FSRef],
    seen: set[str],
) -> None:
    if not commands_dir.is_dir():
        return
    for md in sorted(commands_dir.glob("*.md")):
        if not md.is_file():
            continue
        key = str(md.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(FSRef(md, record_type=RecordType.COMMAND, parent=parent))


async def command_user_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """USER_HOME_FOLDER -> COMMAND. User + cwd only (no per-project)."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        _emit_commands_from(
            Path(node.path) / ".claude" / "commands", node, out, seen
        )
        _emit_commands_from(
            Path(os.getcwd()) / ".claude" / "commands", node, out, seen
        )
    return out
