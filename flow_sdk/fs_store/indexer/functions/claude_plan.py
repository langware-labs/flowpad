"""Indexer functions: PLAN discovery.

Two registrations:
  USER_HOME_FOLDER -> PLAN   (user home ~/.claude/plans, cwd, FLOWPAD_PLAN_DIRS)
  REAL_PROJECT_CWD -> PLAN   (per-project <cwd>/.claude/plans)

Together these reproduce the behavior of
flow_sdk/fs_records/claude/claude_plan.py:_plan_search_dirs + _external_source_iter.
"""

from __future__ import annotations

import os
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def _emit_plans_from_dir(
    plans_dir: Path,
    parent: FSRef,
    out: list[FSRef],
    seen: set[str],
) -> None:
    """Glob *.md in plans_dir (non-recursive), dedup by resolved path."""
    if not plans_dir.is_dir():
        return
    for md in sorted(plans_dir.glob("*.md")):
        key = str(md.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(FSRef(md, record_type=RecordType.PLAN, parent=parent))


async def claude_plan_user_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """USER_HOME_FOLDER -> PLAN. User-level plan dirs (not per-project)."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        home_plans = Path(node.path) / ".claude" / "plans"
        _emit_plans_from_dir(home_plans, node, out, seen)
        cwd_plans = Path(os.getcwd()) / ".claude" / "plans"
        _emit_plans_from_dir(cwd_plans, node, out, seen)
        for extra in os.environ.get("FLOWPAD_PLAN_DIRS", "").split(":"):
            if extra.strip():
                _emit_plans_from_dir(Path(extra.strip()), node, out, seen)
    return out


async def claude_plan_project_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """REAL_PROJECT_CWD -> PLAN. Per-project plan dirs."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        plans = Path(node.path) / ".claude" / "plans"
        _emit_plans_from_dir(plans, node, out, seen)
    return out
