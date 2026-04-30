"""Indexer functions: MARKDOWN discovery.

Two functions, split by registration scope:

  markdown_flat_fn
      rglob <root>/.claude/docs/**/*.md.
      Register on USER_HOME_FOLDER only — ``~/`` is a huge tree where
      unrestricted ``docs/`` discovery would pick up unrelated dirs from
      venvs, npm packages, etc. The narrow ``.claude/docs`` prefix keeps
      home-dir scanning bounded.

  markdown_in_folder_fn
      Per-FOLDER emitter. Receives FOLDER refs from
      ``project_folder_walker_fn`` (which already pruned via gitignore +
      _WALK_IGNORED) and emits the direct ``*.md`` children of every
      walked folder. Register on FOLDER. Gitignore is the only filter —
      every ``.md`` in a project (or system project) is indexed.

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


# Folders whose .md children are claimed by typed indexers (skill_fn, agent_fn,
# workflow_fn, command_fn). Skip emission to avoid double-indexing a SKILL.md
# as both SKILL and MARKDOWN.
_TYPED_RECORD_DIRS: frozenset[str] = frozenset({
    "skills", "agents", "workflows", "commands",
})


def _has_typed_ancestor(folder: Path) -> bool:
    """True if ``folder`` itself or any ancestor is a typed-record dir."""
    p = folder
    while True:
        if p.name in _TYPED_RECORD_DIRS:
            return True
        if p.parent == p:
            return False
        p = p.parent


async def markdown_in_folder_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """For each walked FOLDER, emit its direct ``*.md`` children.

    The walker already descended every subdirectory and filtered via
    gitignore + ``_WALK_IGNORED``; this function only emits — no glob
    recursion needed (use ``glob`` not ``rglob``).

    Folders under typed-record dirs (``skills/``, ``agents/``, ``workflows/``,
    ``commands/``) are skipped so SKILL.md / agent .md / workflow .md aren't
    double-indexed as MARKDOWN.
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        if node.record_type != RecordType.FOLDER:
            continue
        folder_path = Path(node.path)
        if _has_typed_ancestor(folder_path):
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
