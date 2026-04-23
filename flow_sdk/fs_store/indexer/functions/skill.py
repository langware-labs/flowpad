"""Indexer functions: SKILL discovery.

Two registrations:
  USER_HOME_FOLDER -> SKILL   (user + flowpad_assistant + cwd + FLOWPAD_SKILL_DIRS)
  REAL_PROJECT_CWD -> SKILL   (per-project .claude/skills/)

A SKILL is a directory containing SKILL.md OR skill.yaml OR skill.yml.
Reproduces flow_sdk/fs_records/skill_record.py:_skill_search_dirs + discover_iter
(path-only; record construction deferred to index stage).
"""

from __future__ import annotations

import os
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def _emit_skills_from(
    skills_dir: Path,
    parent: FSRef,
    out: list[FSRef],
    seen: set[str],
) -> None:
    if not skills_dir.is_dir():
        return
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
        out.append(FSRef(entry, record_type=RecordType.SKILL, parent=parent))


async def skill_user_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """USER_HOME_FOLDER -> SKILL. User + system + cwd + env."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        _emit_skills_from(Path(node.path) / ".claude" / "skills", node, out, seen)
        try:
            from flow_sdk.config import flowpad_assistant_project_root
            _emit_skills_from(
                flowpad_assistant_project_root() / ".claude" / "skills",
                node, out, seen,
            )
        except Exception:
            pass
        _emit_skills_from(
            Path(os.getcwd()) / ".claude" / "skills", node, out, seen
        )
        for extra in os.environ.get("FLOWPAD_SKILL_DIRS", "").split(":"):
            if extra.strip():
                _emit_skills_from(Path(extra.strip()), node, out, seen)
    return out


async def skill_project_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """REAL_PROJECT_CWD -> SKILL. Per-project .claude/skills/."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        _emit_skills_from(
            Path(node.path) / ".claude" / "skills", node, out, seen
        )
    return out
