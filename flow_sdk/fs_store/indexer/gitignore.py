"""Gitignore-aware walk helpers — the shared matching engine for every tree
walker in the codebase. The FSIndexer project folder walker, the asset-menu
``walk_markdown_files``, and the llm_index Merkle scanner all consume it through
the shared :mod:`flow_sdk.fs_store.indexer.walk`; the fsop watcher filter
(:mod:`flow_sdk.server.fsop_filters`) reuses these matching primitives directly
over its own bounded discovery walk.

Two-stage matching:

1. ``_WALK_IGNORED`` — hardcoded basename denylist (``.git``, ``node_modules``,
   ``.venv``, build/cache dirs). Cheap fast-path consulted before any
   ``.gitignore`` parse so a 50k-file ``node_modules`` becomes a single stat.

2. ``GitIgnoreSpec`` stack — one entry per directory that contains a
   ``.gitignore``. Patterns are matched relative to the directory that owns
   the file, last-match-wins across the stack. ``GitIgnoreSpec`` (over plain
   ``PathSpec``) is the spec-correct matcher for git's wildmatch semantics
   including re-include corner cases.

Force-include: paths under ``.claude/`` are never ignored, even when
``.claude/`` is gitignored at the project root. Project skills/agents/commands
must continue to be discovered.
"""

from __future__ import annotations

from pathlib import Path
from typing import Tuple

from pathspec import GitIgnoreSpec

# Hardcoded fast-path. Match by basename. Skipped without consulting any
# .gitignore. Mirrors the older _WALK_IGNORED in markdown_record.py.
_WALK_IGNORED: frozenset[str] = frozenset({
    ".git", "node_modules", ".venv", "venv", "__pycache__",
    ".tox", "dist", "build", ".eggs", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".next", ".nuxt", "coverage", ".cache",
    # macOS zip-extraction junk: __MACOSX holds only AppleDouble (._*)
    # resource-fork sidecars — binary, never real content.
    "__MACOSX",
    # Flowpad-generated state dirs (llm_index summary caches, markdown-index
    # sidecars, instance state). Never content — no walker should enter them.
    ".flowpad", ".markdown_index", ".llm_index",
})


# Always include — even if a .gitignore says otherwise. Match by basename.
_FORCE_INCLUDE: frozenset[str] = frozenset({".claude"})


def _is_claude_worktree(path: Path) -> bool:
    """True if ``path`` is under ``.claude/worktrees`` (an agent git-worktree).

    These are ephemeral, isolation-mode worktrees — each a FULL repo copy with
    thousands of files. They live under ``.claude/``, so the ``.claude``
    force-include (which exists to catch project skills/agents/commands) would
    otherwise pull every worktree's tree into the index, making a single
    ``markdown`` discover walk tens of thousands of duplicate files. Skip the
    ``worktrees`` subtree specifically while keeping the rest of ``.claude``."""
    parts = path.parts
    for i in range(len(parts) - 1):
        if parts[i] == ".claude" and parts[i + 1] == "worktrees":
            return True
    return False


GitignoreStack = list[Tuple[Path, GitIgnoreSpec]]


def is_denylisted(path: Path) -> bool:
    """Hardcoded skip: ``_WALK_IGNORED`` basename or an agent worktree.

    The gitignore-free fast-path — usable on its own by walkers that skip
    generated/vendor dirs without honoring ``.gitignore``.
    """
    return path.name in _WALK_IGNORED or _is_claude_worktree(path)


def _is_force_include(path: Path, root: Path) -> bool:
    """True if any ancestor of ``path`` (up to ``root``) is in _FORCE_INCLUDE."""
    p = path
    while True:
        if p.name in _FORCE_INCLUDE:
            return True
        if p == root or p.parent == p:
            return False
        p = p.parent


def load_gitignore_stack(root: Path) -> GitignoreStack:
    """Initial stack: just the root's ``.gitignore`` if it exists.

    Nested ``.gitignore`` files are picked up incrementally during the walk
    via :func:`push_gitignore`. We only seed the root here.
    """
    stack: GitignoreStack = []
    gi = root / ".gitignore"
    # The is_file() stat itself can raise (e.g. PermissionError inside an
    # unreadable mount) — one bad directory must skip, never abort the walk.
    try:
        if gi.is_file():
            lines = gi.read_text(encoding="utf-8", errors="replace").splitlines()
            stack.append((root, GitIgnoreSpec.from_lines(lines)))
    except OSError:
        pass
    return stack


def push_gitignore(stack: GitignoreStack, dir_path: Path) -> int:
    """If ``dir_path`` has a ``.gitignore``, push onto stack. Return pushes (0 or 1)."""
    gi = dir_path / ".gitignore"
    try:
        if not gi.is_file():
            return 0
        lines = gi.read_text(encoding="utf-8", errors="replace").splitlines()
        stack.append((dir_path, GitIgnoreSpec.from_lines(lines)))
        return 1
    except OSError:
        return 0


def is_ignored(
    path: Path, is_dir: bool, stack: GitignoreStack, root: Path,
) -> bool:
    """Return True if ``path`` should be skipped.

    Ordering:
      1. If basename in ``_WALK_IGNORED`` → ignored (fast-path).
      2. If under ``.claude/worktrees`` → ignored (agent worktrees, full repo
         copies; overrides the ``.claude`` force-include below).
      3. If basename in ``_FORCE_INCLUDE`` ancestor chain → never ignored.
      4. Walk the gitignore stack outermost→innermost, last-match-wins.
    """
    if is_denylisted(path):
        return True
    if _is_force_include(path, root):
        return False

    ignored = False
    for base_dir, spec in stack:
        try:
            rel = path.relative_to(base_dir)
        except ValueError:
            continue
        rel_str = str(rel)
        # GitIgnoreSpec matches both files and dirs; for dir-only patterns
        # (trailing /) we append the slash to disambiguate.
        candidate = rel_str + "/" if is_dir else rel_str
        if spec.match_file(candidate):
            ignored = True
        elif is_dir and spec.match_file(rel_str):
            # Some pattern forms (no trailing slash) still match dirs.
            ignored = True
    return ignored
