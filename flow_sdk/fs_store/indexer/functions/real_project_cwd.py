"""Indexer function: USER_HOME_FOLDER -> REAL_PROJECT_CWD.

Emits one REAL_PROJECT_CWD node per known project — sourced through the
canonical ``get_all_projects()`` helper (Claude scan ∪ Codex scan ∪ Project
entity table, deduped by canonical posix cwd). Side-effect: any FS-discovered
cwd not yet in the entity table is materialized as a Project here, so picker /
indexer / scan converge on the same set.

This replaces the previous Claude-only walk (``iter_claude_project_paths``)
that left flowpad-only Project entities invisible to the indexer.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def _dedup_nested(cwds: list[str]) -> list[str]:
    """WALK-COVERAGE dedup: keep only outermost cwds — an outer root's walk
    already covers every nested project's files, so walking the inner root too
    would just double-parse them.

    This is NOT the association rule. Which project a file belongs to is
    decided at the stamp site (deepest-project-wins via
    ``roots.deepest_project_id_for_path``) — files inside a nested project keep
    the INNER project's id even though only the outer root walks them.
    """
    from flow_sdk.fs_store.path_utils import is_path_under

    sorted_cwds = sorted(cwds, key=len)
    kept: list[str] = []
    for cwd in sorted_cwds:
        if not any(is_path_under(cwd, k) for k in kept):
            kept.append(cwd)
    return kept


async def real_project_cwd_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    from flow_sdk.fs_store.operations.all_projects import get_all_projects
    from flow_sdk.fs_store.scope import Scope

    projects = await get_all_projects(
        include_temp=opts.include_temp, create_missing=True
    )

    # Drop nested projects — each file should be scoped to its outermost project.
    outermost = set(_dedup_nested([info.cwd for info in projects]))

    out: list[FSRef] = []
    for node in nodes:
        for info in projects:
            if info.cwd not in outermost:
                continue
            out.append(
                FSRef(
                    Path(info.cwd),
                    record_type=RecordType.REAL_PROJECT_CWD,
                    parent=node,
                    scope=Scope.PROJECT.value,
                    project_id=info.project_id,
                )
            )
    return out
