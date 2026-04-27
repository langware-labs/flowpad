"""Validate the FOLDER fan-out walker on the flowpad-oss repo itself.

Exercises the same path that ``fastScanProject(projectId)`` uses on the
backend: ``custom_roots = (FSRef(<project_root>, REAL_PROJECT_CWD, ...,
project_id=...),)`` threaded into ``IndexerOptions(roots=...,
project_id=...)``. Validates:

  - the walker emits FOLDER refs for the project tree, gitignore-aware;
  - FOLDER is transient (no record_cls, never persisted);
  - markdown is discovered via the FOLDER → markdown_in_folder_fn fan-out;
  - markdown count **exactly equals** the disk-walk under the same predicate
    (gitignore + _WALK_IGNORED + docs-ancestor);
  - hardcoded ``_WALK_IGNORED`` (.git, node_modules, .venv) is pruned;
  - .claude/ is force-included even if gitignored;
  - ``project_id`` flows from IndexerOptions / root FSRef onto every emitted
    MARKDOWN ref via parent-chain inheritance.

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
from flow_sdk.fs_store.indexer.functions.markdown import _has_docs_ancestor
from flow_sdk.fs_store.indexer.gitignore import (
    is_ignored,
    load_gitignore_stack,
    push_gitignore,
)
from flow_sdk.fs_store.record_types import RecordType


# Project root = the flowpad-oss working tree (this file lives under
# tests/unit/test_fs_store/ so .parents[3] is the repo root).
PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _expected_markdown_paths(root: Path) -> set[Path]:
    """Independent disk walk that mirrors the indexer's filtering rules.

    Walks the tree applying the same gitignore + _WALK_IGNORED + .claude
    force-include rules used by ``project_folder_walker_fn``, then filters
    to ``*.md`` files in directories whose name is "docs" or has a "docs"
    ancestor up to the root — same predicate as ``markdown_in_folder_fn``.
    """
    expected: set[Path] = set()
    stack = load_gitignore_stack(root)

    def walk(d: Path, push_count: int) -> None:
        # Emit *.md from this directory if it matches the docs-ancestor
        # predicate. The walker also visits the root itself, so the
        # predicate is evaluated for every directory we descend into.
        if _has_docs_ancestor(d, root):
            try:
                for md in d.glob("*.md"):
                    if md.is_file():
                        expected.add(md.resolve())
            except OSError:
                pass

        try:
            children = sorted(d.iterdir())
        except (OSError, PermissionError):
            return
        for child in children:
            try:
                if not child.is_dir() or child.is_symlink():
                    continue
            except OSError:
                continue
            if is_ignored(child, True, stack, root):
                continue
            pushed = push_gitignore(stack, child)
            walk(child, pushed)
            if pushed:
                del stack[-pushed:]

    walk(root, 0)
    return expected


@pytest.mark.asyncio
async def test_folder_walker_on_flowpad_oss(tmp_path: Path, capsys) -> None:
    """Run scan() over flowpad-oss, report timing, assert exact MD count and
    project_id propagation."""
    indexer = build_default_indexer(state_dir=tmp_path / "idx_state")

    test_pid = "test-pid-flowpad-oss"
    custom_roots = (
        FSRef(
            PROJECT_ROOT,
            record_type=RecordType.REAL_PROJECT_CWD,
            scope="project",
            project_id=test_pid,
        ),
    )

    t0 = time.perf_counter()
    refs = await indexer.scan(IndexerOptions(
        verbose=False,
        roots=custom_roots,
        gitignore=True,
        project_id=test_pid,
    ))
    walk_ms = (time.perf_counter() - t0) * 1000

    folders = [r for r in refs if r.record_type == RecordType.FOLDER]
    md_refs = [r for r in refs if r.record_type == RecordType.MARKDOWN]

    folder_paths = [r.path for r in folders]
    md_paths = {Path(r.path).resolve() for r in md_refs}

    # _WALK_IGNORED must have pruned these.
    for forbidden in ("/node_modules/", "/.git/", "/.venv/", "/__pycache__/"):
        assert not any(forbidden in p for p in folder_paths), (
            f"walker descended into {forbidden} — _WALK_IGNORED prune broken"
        )

    # Force-include: .claude/ folders must still appear (project scaffolding).
    assert any("/.claude" in p for p in folder_paths), (
        ".claude/ not visited — force-include broken"
    )

    # Exact-count check: independently walk disk under the same rules.
    expected = _expected_markdown_paths(PROJECT_ROOT)
    extra = md_paths - expected
    missing = expected - md_paths
    assert not missing, (
        f"walker missed {len(missing)} markdown files. Examples: "
        f"{sorted(str(p) for p in list(missing)[:5])}"
    )
    assert not extra, (
        f"walker emitted {len(extra)} markdown files NOT in disk-walk. Examples: "
        f"{sorted(str(p) for p in list(extra)[:5])}"
    )
    assert len(md_refs) == len(expected), (
        f"count mismatch: walker={len(md_refs)} expected={len(expected)}"
    )

    # project_id must inherit via the parent chain onto every MARKDOWN ref.
    pid_mismatched = [r for r in md_refs if r.project_id != test_pid]
    assert not pid_mismatched, (
        f"{len(pid_mismatched)}/{len(md_refs)} MARKDOWN refs have wrong "
        f"project_id (sample: {[r.project_id for r in pid_mismatched[:3]]})"
    )

    print(
        f"\n[folder-walker] root={PROJECT_ROOT.name}  "
        f"walk_time={walk_ms:.1f}ms  folders={len(folders)}  "
        f"markdowns={len(md_refs)} (== disk-walk)  "
        f"project_id_propagated={all(r.project_id == test_pid for r in md_refs)}",
    )
    capsys.disabled() if hasattr(capsys, "disabled") else None


@pytest.mark.asyncio
async def test_folder_is_transient_not_persisted(tmp_path: Path) -> None:
    """FOLDER must have no SchemaRegistry record_cls — never persisted to DB."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    info = SchemaRegistry.get(str(RecordType.FOLDER))
    if info is not None:
        assert info.record_cls is None or not hasattr(
            info.record_cls, "from_fsref",
        ), "FOLDER must not be backed by a Record subclass — would get persisted"
