"""Indexer functions: AGENT discovery.

Two registrations:
  USER_HOME_FOLDER -> AGENT   (user + flowpad_assistant + cwd + FLOWPAD_AGENT_DIRS)
  REAL_PROJECT_CWD -> AGENT   (per-project .claude/agents/)

Reproduces flow_sdk/fs_records/agent_record.py:_agent_search_dirs + _external_source_iter.
"""

from __future__ import annotations

import os
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def _emit_agents_from(
    agents_dir: Path,
    parent: FSRef,
    out: list[FSRef],
    seen: set[str],
) -> None:
    if not agents_dir.is_dir():
        return
    for md in sorted(agents_dir.glob("*.md")):
        key = str(md.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(FSRef(md, record_type=RecordType.AGENT, parent=parent))


async def agent_user_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """USER_HOME_FOLDER -> AGENT."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        _emit_agents_from(Path(node.path) / ".claude" / "agents", node, out, seen)
        try:
            from flow_sdk.config import flowpad_assistant_project_root
            _emit_agents_from(
                flowpad_assistant_project_root() / ".claude" / "agents",
                node, out, seen,
            )
        except Exception:
            pass
        _emit_agents_from(
            Path(os.getcwd()) / ".claude" / "agents", node, out, seen
        )
        for extra in os.environ.get("FLOWPAD_AGENT_DIRS", "").split(":"):
            if extra.strip():
                _emit_agents_from(Path(extra.strip()), node, out, seen)
    return out


async def agent_project_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """REAL_PROJECT_CWD -> AGENT."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        _emit_agents_from(
            Path(node.path) / ".claude" / "agents", node, out, seen
        )
    return out
