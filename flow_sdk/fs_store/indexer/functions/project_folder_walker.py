"""Project-scope folder walker — gitignore-aware DFS that emits FOLDER refs.

Registered on REAL_PROJECT_CWD and CWD_ROOT. Fires once per project root and
delegates the tree walk to the shared :func:`gitignore_walk`
(:mod:`flow_sdk.fs_store.indexer.walk`), which honors (in order):

  1. ``_FORCE_INCLUDE`` — ``.claude/`` is always traversed.
  2. ``_WALK_IGNORED`` — hardcoded basename denylist (``.git``, ``node_modules``,
     build/cache dirs). Pruned without parsing any .gitignore.
  3. ``.gitignore`` stack — when ``opts.gitignore`` is True. Specs are pushed
     as the walker enters a directory containing one, popped on the way out.

With ``opts.gitignore=False`` the walk is a pure pass-through (legacy
behavior: even the denylist is skipped; only symlink/unreadable dirs drop).

Emits one ``FSRef(record_type=FOLDER, parent=<root_node>)`` per surviving
directory (including the root itself). FOLDER is a transient scaffold type —
no record_cls registered, never persisted. Downstream functions register
on FOLDER and filter by predicate (e.g. ``markdown_in_folder_fn``).
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.indexer.walk import gitignore_walk
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
        for dir_path, _subdirs, _files in gitignore_walk(
            root_path,
            gitignore=opts.gitignore,
            denylist=opts.gitignore,
            include_files=False,
        ):
            out.append(FSRef(dir_path, record_type=RecordType.FOLDER, parent=node))
    return out
