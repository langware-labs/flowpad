"""Project-scope folder walker — gitignore-aware DFS that emits FOLDER refs.

Registered on REAL_PROJECT_CWD and CWD_ROOT. Fires once per project root,
walks the entire subtree honoring (in order):

  1. ``_FORCE_INCLUDE`` — ``.claude/`` is always traversed.
  2. ``_WALK_IGNORED`` — hardcoded basename denylist (``.git``, ``node_modules``,
     build/cache dirs). Pruned without parsing any .gitignore.
  3. ``.gitignore`` stack — when ``opts.gitignore`` is True. Specs are pushed
     as the walker enters a directory containing one, popped on the way out.

Emits one ``FSRef(record_type=FOLDER, parent=<root_node>)`` per surviving
directory (including the root itself). FOLDER is a transient scaffold type —
no record_cls registered, never persisted. Downstream functions register
on FOLDER and filter by predicate (e.g. ``markdown_in_folder_fn``).
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.gitignore import (
    GitignoreStack,
    is_ignored,
    load_gitignore_stack,
    push_gitignore,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def project_folder_walker_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """Walk each project root, emit one FOLDER FSRef per surviving directory."""
    out: list[FSRef] = []
    for node in nodes:
        root_path = Path(node.path)
        if not root_path.is_dir():
            continue

        stack: GitignoreStack = (
            load_gitignore_stack(root_path) if opts.gitignore else []
        )

        # Iterative DFS. (depth, dir_path, pushed_count) — pushed_count tracks
        # how many entries this dir contributed to the gitignore stack so we
        # can pop on backtrack.
        # The root is always emitted (even if ignored — caller asked us to
        # walk it).
        out.append(FSRef(root_path, record_type=RecordType.FOLDER, parent=node))

        # Stack frames hold deferred work for backtracking.
        frames: list[tuple[Path, list[Path], int]] = []
        # Frame init for root:
        children = _list_subdirs(root_path)
        # Apply gitignore filtering BEFORE recursing.
        children = [
            c for c in children
            if not (opts.gitignore and is_ignored(c, True, stack, root_path))
        ]
        frames.append((root_path, children, 0))

        while frames:
            cur_dir, remaining, popped_marker = frames[-1]
            if not remaining:
                # Backtrack: pop gitignore entries pushed at this frame.
                if opts.gitignore and popped_marker:
                    del stack[-popped_marker:]
                frames.pop()
                continue

            child = remaining.pop()
            out.append(FSRef(child, record_type=RecordType.FOLDER, parent=node))

            # Push child's .gitignore (if any) onto the stack BEFORE descending.
            pushed = push_gitignore(stack, child) if opts.gitignore else 0

            # Compute child's children with gitignore filtering applied.
            subchildren = _list_subdirs(child)
            subchildren = [
                c for c in subchildren
                if not (opts.gitignore and is_ignored(c, True, stack, root_path))
            ]
            frames.append((child, subchildren, pushed))

    return out


def _list_subdirs(d: Path) -> list[Path]:
    """Sorted list of immediate subdirectories of ``d``. Symlinks not followed."""
    try:
        entries = sorted(d.iterdir(), reverse=True)  # reversed so pop() goes alphabetical
    except (OSError, PermissionError):
        return []
    out: list[Path] = []
    for e in entries:
        try:
            if e.is_dir() and not e.is_symlink():
                out.append(e)
        except OSError:
            continue
    return out
