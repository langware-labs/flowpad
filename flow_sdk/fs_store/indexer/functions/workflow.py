"""Indexer functions: WORKFLOW discovery.

Two registrations:
  USER_HOME_FOLDER -> WORKFLOW  (user + cwd + FLOWPAD_WORKFLOW_DIRS)
  REAL_PROJECT_CWD -> WORKFLOW  (per-project .claude/workflows/)

Reproduces flow_sdk/fs_records/workflow_record.py:_workflow_search_dirs
+ _external_source_iter.
"""

from __future__ import annotations

import os
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def _emit_workflows_from(
    workflows_dir: Path,
    parent: FSRef,
    out: list[FSRef],
    seen: set[str],
) -> None:
    if not workflows_dir.is_dir():
        return
    for md in sorted(workflows_dir.glob("*.md")):
        key = str(md.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(FSRef(md, record_type=RecordType.WORKFLOW, parent=parent))


async def workflow_user_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """USER_HOME_FOLDER -> WORKFLOW."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        _emit_workflows_from(
            Path(node.path) / ".claude" / "workflows", node, out, seen
        )
        _emit_workflows_from(
            Path(os.getcwd()) / ".claude" / "workflows", node, out, seen
        )
        for extra in os.environ.get("FLOWPAD_WORKFLOW_DIRS", "").split(":"):
            if extra.strip():
                _emit_workflows_from(Path(extra.strip()), node, out, seen)
    return out


async def workflow_project_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """REAL_PROJECT_CWD -> WORKFLOW."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        _emit_workflows_from(
            Path(node.path) / ".claude" / "workflows", node, out, seen
        )
    return out
