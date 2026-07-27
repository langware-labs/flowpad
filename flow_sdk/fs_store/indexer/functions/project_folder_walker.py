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
    import os  # noqa: PLC0415

    from flow_sdk.fs_store.indexer.special_folders import (  # noqa: PLC0415
        FolderKind,
        classify_special_folder,
        mark_denied,
    )

    out: list[FSRef] = []
    for node in nodes:
        root_path = Path(node.path)
        if not root_path.is_dir():
            continue
        # A protected-folder root only reaches here when it was explicitly
        # allowed / opened. The FIRST real read is where macOS shows its prompt;
        # if the user clicks "Don't Allow", the read raises EPERM. Detect that
        # once, mark the folder ``denied`` (so we never re-read → never re-prompt),
        # and skip — instead of letting gitignore_walk swallow it silently and
        # re-prompt on every future scan.
        _sf = classify_special_folder(root_path)
        if _sf is not None and _sf.kind is FolderKind.TRISTATE:
            try:
                with os.scandir(root_path) as _it:
                    next(_it, None)
            except PermissionError:
                mark_denied(root_path)
                continue
            except OSError:
                continue
        for dir_path, _subdirs, _files in gitignore_walk(
            root_path,
            gitignore=opts.gitignore,
            denylist=opts.gitignore,
            include_files=False,
        ):
            out.append(FSRef(dir_path, record_type=RecordType.FOLDER, parent=node))
    return out
