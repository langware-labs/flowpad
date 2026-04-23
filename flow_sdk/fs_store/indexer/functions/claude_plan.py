"""Indexer function: <root> -> PLAN.

Emits PLAN records for every `*.md` in `<root>/.claude/plans/`. Layout is
identical across user, project, and cwd roots — register this one function
on USER_HOME_FOLDER, REAL_PROJECT_CWD, and CWD_ROOT; scope inherits from
whichever root the call chain started at.

Reproduces the path set of flow_sdk/fs_records/claude/claude_plan.py:
_plan_search_dirs + _external_source_iter. FLOWPAD_PLAN_DIRS env-var
support is deferred (empty on this machine; separate follow-up if needed).
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def claude_plan_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        plans = Path(node.path) / ".claude" / "plans"
        if not plans.is_dir():
            continue
        for md in sorted(plans.glob("*.md")):
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(md, record_type=RecordType.PLAN, parent=node))
    return out
