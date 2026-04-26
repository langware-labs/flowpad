"""Validate the FOLDER fan-out walker on the flowpad-oss repo itself.

Exercises the same path that ``fastScanProject(projectId)`` uses on the
backend: ``custom_roots = (FSRef(<project_root>, REAL_PROJECT_CWD, ...),)``
threaded into ``IndexerOptions(roots=...)``. Validates:

  - the walker emits FOLDER refs for the project tree, gitignore-aware;
  - FOLDER is transient (no record_cls, never persisted);
  - markdown is discovered via the FOLDER → markdown_in_folder_fn fan-out;
  - hardcoded ``_WALK_IGNORED`` (.git, node_modules, .venv) is pruned;
  - .claude/ is force-included even if gitignored.

Reports walk time and markdown count via -s prints.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import (
    IndexerOptions,
    build_default_indexer,
)
from flow_sdk.fs_store.record_types import RecordType


# Project root = the flowpad-oss working tree (this file lives under
# tests/unit/test_fs_store/ so .parents[3] is the repo root).
PROJECT_ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.asyncio
async def test_folder_walker_on_flowpad_oss(tmp_path: Path, capsys) -> None:
    """Run scan() over flowpad-oss, report walk time + counts, assert sanity."""
    indexer = build_default_indexer(state_dir=tmp_path / "idx_state")

    # Same shape as fs_records_actions._handle_fs_records_index when project_id
    # is provided: one REAL_PROJECT_CWD root scoped to the project subtree.
    custom_roots = (
        FSRef(
            PROJECT_ROOT,
            record_type=RecordType.REAL_PROJECT_CWD,
            scope="project",
        ),
    )

    t0 = time.perf_counter()
    refs = await indexer.scan(IndexerOptions(
        verbose=False,
        roots=custom_roots,
        gitignore=True,
    ))
    walk_ms = (time.perf_counter() - t0) * 1000

    folder_count = sum(1 for r in refs if r.record_type == RecordType.FOLDER)
    md_count = sum(1 for r in refs if r.record_type == RecordType.MARKDOWN)

    folder_paths = [r.path for r in refs if r.record_type == RecordType.FOLDER]

    # _WALK_IGNORED must have pruned these.
    for forbidden in ("/node_modules/", "/.git/", "/.venv/", "/__pycache__/"):
        assert not any(forbidden in p for p in folder_paths), (
            f"walker descended into {forbidden} — _WALK_IGNORED prune broken"
        )

    # Force-include: .claude/ folders must still appear (project scaffolding).
    assert any("/.claude" in p for p in folder_paths), (
        ".claude/ not visited — force-include broken"
    )

    # Sanity floors. flowpad-oss ships dozens of markdown files (CLAUDE.md,
    # docs/, .claude/docs/, system_projects/.../docs/...). If we get zero,
    # the FOLDER → markdown_in_folder_fn fan-out is broken.
    assert folder_count > 50, f"too few folders walked: {folder_count}"
    assert md_count > 10, f"markdown fan-out emitted too few refs: {md_count}"

    print(
        f"\n[folder-walker] root={PROJECT_ROOT.name}  "
        f"walk_time={walk_ms:.1f}ms  folders={folder_count}  "
        f"markdowns={md_count}",
    )
    # Surface the print even when pytest captures stdout.
    capsys.disabled() if hasattr(capsys, "disabled") else None


@pytest.mark.asyncio
async def test_folder_is_transient_not_persisted(tmp_path: Path) -> None:
    """FOLDER must have no SchemaRegistry record_cls — never persisted to DB.

    The index() loop skips refs whose record_cls is None (or lacks from_fsref),
    so registering no record class for FOLDER is sufficient to keep it
    transient.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    info = SchemaRegistry.get(str(RecordType.FOLDER))
    if info is not None:
        assert info.record_cls is None or not hasattr(
            info.record_cls, "from_fsref",
        ), "FOLDER must not be backed by a Record subclass — would get persisted"
