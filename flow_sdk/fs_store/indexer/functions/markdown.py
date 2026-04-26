"""Indexer functions: MARKDOWN discovery.

Two functions, split by registration scope:

  markdown_flat_fn
      rglob <root>/.claude/docs/**/*.md.
      Register on USER_HOME_FOLDER, SYSTEM_ROOT — these are huge trees
      (~/, the system project root) where unrestricted ``docs/`` discovery
      would pick up unrelated dirs from venvs, npm packages, etc.

  markdown_in_folder_fn
      Per-FOLDER predicate emitter. Receives FOLDER refs from
      ``project_folder_walker_fn`` (which already pruned via gitignore +
      _WALK_IGNORED) and emits ``*.md`` direct children of folders that
      match: name == "docs" OR has a "docs" ancestor up to the project
      root. Register on FOLDER.

Together with the folder walker this collapses the old per-type rglob
into one walk per project — adding new file types (txt, csv) is a single
function registered on FOLDER.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def _emit_md_rglob(
    root: Path, parent: FSRef, out: list[FSRef], seen: set[str],
) -> None:
    if not root.is_dir():
        return
    for md in sorted(root.rglob("*.md")):
        key = str(md.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(FSRef(md, record_type=RecordType.MARKDOWN, parent=parent))


async def markdown_flat_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """<root>/.claude/docs/**/*.md — flat, no docs-subdir search."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        _emit_md_rglob(Path(node.path) / ".claude" / "docs", node, out, seen)
    return out


def _has_docs_ancestor(folder: Path, walk_root: Path) -> bool:
    """True if ``folder`` itself is named 'docs', or any ancestor up to
    (and including) walk_root is. Used to gate per-FOLDER markdown emission.
    """
    p = folder
    while True:
        if p.name == "docs":
            return True
        if p == walk_root or p.parent == p:
            return False
        p = p.parent


def _find_walk_root(folder_ref: FSRef) -> Path | None:
    """Walk up the FSRef parent chain to the project/cwd root."""
    cur = folder_ref
    while cur._parent is not None:
        if cur._parent.record_type in (
            RecordType.REAL_PROJECT_CWD, RecordType.CWD_ROOT,
        ):
            return Path(cur._parent.path)
        cur = cur._parent
    return None


async def markdown_in_folder_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """For each FOLDER under a docs ancestor, emit its direct ``*.md`` children.

    The walker already descended every subdirectory and filtered via gitignore;
    this function only emits — no glob recursion needed (use ``glob`` not
    ``rglob``).
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        if node.record_type != RecordType.FOLDER:
            continue
        folder_path = Path(node.path)
        walk_root = _find_walk_root(node)
        if walk_root is None:
            continue
        if not _has_docs_ancestor(folder_path, walk_root):
            continue
        try:
            entries = sorted(folder_path.glob("*.md"))
        except OSError:
            continue
        for md in entries:
            try:
                if not md.is_file():
                    continue
            except OSError:
                continue
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(md, record_type=RecordType.MARKDOWN, parent=node))
    return out
