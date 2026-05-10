"""Indexer function: USER_HOME_FOLDER -> REAL_PROJECT_CWD.

Emits one REAL_PROJECT_CWD node per decoded user project cwd, as reported by
iter_claude_project_paths() in flow_sdk/fs_records/_claude_projects.py.

This is the unification point: every per-project walker in the legacy code
(PLAN, CLAUDE_MD, CLAUDE_RULES, SPEC, CLAUDE_MEMORY, SKILL, AGENT, WORKFLOW,
COMMAND) calls iter_claude_project_paths() independently. With this node,
the decode happens once per scan and is shared across all downstream
per-project functions.

The current implementation matches legacy behavior byte-for-byte, including
the decode foot-gun ('/' and '$HOME' leakage from malformed session JSONLs).
The fix for that bug is deferred — it would alter parity with the legacy
walkers, which is the verification signal for this cut.
"""

from __future__ import annotations

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def real_project_cwd_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    import uuid as _uuid
    from flow_sdk.fs_records._claude_projects import iter_claude_project_paths

    out: list[FSRef] = []
    for node in nodes:
        for real in iter_claude_project_paths(include_temp=opts.include_temp):
            # Explicit scope override: entering a project subtree,
            # regardless of the parent root's scope. project_id is derived
            # from the project's mount path so descendants (skills, agents,
            # workflows, …) inherit a stable foreign-key reference matching
            # the Project entity's allocate_id.
            pid = str(_uuid.uuid5(_uuid.NAMESPACE_DNS, f"project:{str(real)}"))
            out.append(
                FSRef(
                    real,
                    record_type=RecordType.REAL_PROJECT_CWD,
                    parent=node,
                    scope="project",
                    project_id=pid,
                )
            )
    return out
