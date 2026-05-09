"""Indexer function: <root> -> SKILL.

Emits SKILL nodes for each directory in `<root>/.claude/skills/` that
contains SKILL.md, skill.yaml, or skill.yml. Register on USER_HOME_FOLDER,
SYSTEM_ROOT, CWD_ROOT, REAL_PROJECT_CWD; scope inherits via FSRef.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def skill_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        skills_dir = Path(node.path) / ".claude" / "skills"
        if not skills_dir.is_dir():
            continue
        for entry in sorted(skills_dir.iterdir()):
            if not entry.is_dir():
                continue
            if (
                not (entry / "SKILL.md").exists()
                and not (entry / "skill.yaml").exists()
                and not (entry / "skill.yml").exists()
            ):
                continue
            key = str(entry.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(entry, record_type=RecordType.SKILL, parent=node))
    return out
