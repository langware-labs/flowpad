"""Ignore-file-aware walk helpers — the shared skip policy of every tree walker
in the codebase. The FSIndexer project folder walker, the asset-menu
``walk_markdown_files``, and the llm_index Merkle scanner all consume it through
the shared :mod:`flow_sdk.fs_store.indexer.walk`; the fsop watcher filter
(:mod:`flow_sdk.server.fsop_filters`) reuses these matching primitives directly
over its own bounded discovery walk.

Lives outside ``flow_sdk.fs_store.indexer`` so the asset SDK walker
(:mod:`flow_sdk.assets.folder`) can share it without importing index services.

One entry is decided in this order (:func:`is_ignored`):

1. ``_WALK_IGNORED`` — hardcoded basename denylist (``.git``, ``node_modules``,
   ``.venv``, build/cache dirs) and the ``.claude/worktrees`` skip. Absolute:
   no ignore file brings these back, and a 50k-file ``node_modules`` stays a
   single stat.
2. ``.flowignore`` — Flowpad's own rules: what is never indexed, scanned or
   minted. The deepest file with a matching line decides, either way: a ``!``
   line keeps a path a ``.gitignore`` hides.
3. Force-include — paths under ``.claude/`` are kept even when ``.claude/`` is
   gitignored, so project skills/agents/commands are still discovered. It
   guards against a ``.gitignore`` only, never against a ``.flowignore``.
4. ``.gitignore`` — the deepest file with a matching line decides.

Every file is matched exactly as git matches it (:mod:`flow_sdk.fs_store.ignore_rules`),
and a walk never enters an excluded directory, so — as in git — nothing below
one can be re-included. ``.flowignore`` files apply from EVERY folder above a
path, not only from inside the walked root: ``~/.flowignore`` covers the home
folder. The ``.flowignore`` answer always comes from :class:`FlowIgnore`, for a
walk and for a single path alike; the walk's stack holds the ``.gitignore`` files.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Callable, Sequence, Tuple

from flow_sdk.fs_store.ignore_rules import FLOWIGNORE, GITIGNORE, IgnoreFile, read_ignore_file

# Hardcoded fast-path. Match by basename. Skipped without consulting any
# ignore file. Mirrors the older _WALK_IGNORED in markdown_record.py.
_WALK_IGNORED: frozenset[str] = frozenset({
    ".git", "node_modules", ".venv", "venv", "__pycache__",
    ".tox", "dist", "build", ".eggs", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".next", ".nuxt", "coverage", ".cache",
    # macOS zip-extraction junk: __MACOSX holds only AppleDouble (._*)
    # resource-fork sidecars — binary, never real content.
    "__MACOSX",
    # Flowpad-generated state and metadata dirs. They may travel with an asset,
    # but no content walker should enter them.
    # Asset-local FlowPad metadata (named capsules, legacy ids, and future
    # carriers) is transportable content, but never an asset-discovery root.
    ".flow", ".flowpad", ".markdown_index", ".llm_index",
})


# Kept even if a .gitignore says otherwise. Match by basename.
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


#: ``(folder, rules)`` per ``.gitignore`` on the way down to the current
#: directory, outermost first. The folder is kept as the walk spells it.
GitignoreStack = list[Tuple[str, IgnoreFile]]


def is_denylisted(path: Path) -> bool:
    """Hardcoded skip: ``_WALK_IGNORED`` basename or an agent worktree.

    The ignore-file-free fast-path — usable on its own by walkers that skip
    generated/vendor dirs without honoring any ignore file.
    """
    return path.name in _WALK_IGNORED or _is_claude_worktree(path)


def is_under_denylisted_dir(path: Path | str) -> bool:
    """True when any ANCESTOR directory of ``path`` is walk-denylisted.

    ``is_denylisted`` answers this for one directory as a walk descends. A path
    that was *stored* earlier has no walk to ride along with, so the offending
    segment is an ancestor and has to be looked for explicitly — the seam that
    lets retention apply the same policy discovery does. Pure string work: the
    caller may be checking thousands of stored paths.
    """
    p = Path(path)
    return any(part in _WALK_IGNORED for part in p.parts[:-1]) or _is_claude_worktree(p)


def _is_force_include(path: Path, root: Path) -> bool:
    """True if any ancestor of ``path`` (up to ``root``) is in _FORCE_INCLUDE."""
    p = path
    while True:
        if p.name in _FORCE_INCLUDE:
            return True
        if p == root or p.parent == p:
            return False
        p = p.parent


def _relative(path: str, folder: str) -> bytes | None:
    """``path`` below ``folder`` as git names it: ``/``-separated bytes, or None when it is not below."""
    prefix = folder if folder.endswith(os.sep) else folder + os.sep
    if not path.startswith(prefix) or len(path) == len(prefix):
        return None
    rel = path[len(prefix):]
    if os.sep != "/":
        rel = rel.replace(os.sep, "/")
    return os.fsencode(rel)


def stack_verdict(path: str, is_dir: bool, stack: Sequence[tuple[str, IgnoreFile]]) -> bool | None:
    """The deepest file of ``stack`` with a line matching ``path`` decides — True ignored, False kept
    by a ``!`` line, None when none matches."""
    for folder, rules in reversed(stack):
        rel = _relative(path, folder)
        if rel is None:
            continue
        verdict = rules.decide(rel, is_dir)
        if verdict is not None:
            return verdict
    return None


def stack_ignores(
    path: Path, is_dir: bool, stack: GitignoreStack,
    forced: Callable[[Path], bool] | None = None, flow: FlowIgnore | None = None,
) -> bool:
    """Steps 2-4 of :func:`is_ignored` on their own: ``flow``'s ``.flowignore`` verdict, then the
    ``.gitignore`` stack unless ``forced(path)`` says the force-include keeps it.

    Split out so a walk whose denylist / force-include lists arrive as DATA
    (``flow_sdk.diskio``'s ``WalkPolicy``) shares the one rule instead of
    carrying a copy of it.
    """
    if flow is not None:
        verdict = flow.verdict(path, is_dir)
        if verdict is not None:
            return verdict
    if not stack or stack_verdict(str(path), is_dir, stack) is not True:
        return False
    return not (forced and forced(path))


def is_ignored(path: Path, is_dir: bool, stack: GitignoreStack, root: Path, flow: FlowIgnore | None = None) -> bool:
    """Return True if ``path`` should be skipped, as a walk reaches it (its parent was kept).
    ``flow`` brings the ``.flowignore`` rules; without it only ``.gitignore`` applies."""
    if is_denylisted(path):
        return True
    return stack_ignores(path, is_dir, stack, lambda p: _is_force_include(p, root), flow)


def is_ignored_below(path: Path, is_dir: bool, stack: GitignoreStack, root: Path) -> bool:
    """:func:`is_ignored` for a path no walk led to: it is also skipped when a folder between
    ``root`` and it is — git excludes everything inside an excluded folder."""
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        return is_ignored(path, is_dir, stack, root)
    folder = root
    for part in parts[:-1]:
        folder = folder / part
        if is_ignored(folder, True, stack, root):
            return True
    return is_ignored(path, is_dir, stack, root)


def load_gitignore_stack(root: Path) -> GitignoreStack:
    """The stack a walk of ``root`` starts with: the root's ``.gitignore``. Nested files are
    pushed during the walk (:func:`push_gitignore`)."""
    rules = read_ignore_file(str(root), GITIGNORE)
    return [] if rules is None else [(str(root), rules)]


def push_gitignore(stack: GitignoreStack, dir_path: Path) -> int:
    """Push ``dir_path``'s ``.gitignore`` onto ``stack``; how many were pushed (0 or 1)."""
    rules = read_ignore_file(str(dir_path), GITIGNORE)
    if rules is None:
        return 0
    stack.append((str(dir_path), rules))
    return 1


_Chain = Tuple[Tuple[str, IgnoreFile], ...]


class FlowIgnore:
    """Does a ``.flowignore`` exclude this path? For single paths no walk visits — a ref a
    walker emitted, a file a session wrote, a row stored earlier.

    Every ``.flowignore`` from ``/`` down to the path's folder applies, the way git reads
    ``.gitignore`` files down to a path: the deepest file with a matching line decides, and
    a path inside an excluded folder is excluded (that folder's own file is never read).

    One instance per pass (a walk, an index run, a batch of paths): it remembers each
    folder it was asked about, so it must not outlive edits to the files. Paths are made
    absolute (not resolved), so a relative walk root answers as its absolute spelling.
    """

    def __init__(self) -> None:
        self._folders: dict[str, tuple[bool, _Chain]] = {}

    def _folder(self, folder: str) -> tuple[bool, _Chain]:
        """``(excluded, the .flowignore files that apply inside it)`` for an absolute folder."""
        known = self._folders.get(folder)
        if known is not None:
            return known
        parent = os.path.dirname(folder)
        if parent == folder:
            excluded, chain = False, ()
        else:
            excluded, chain = self._folder(parent)
            if not excluded and stack_verdict(folder, True, chain) is True:
                excluded = True
        if excluded:
            state: tuple[bool, _Chain] = (True, ())
        else:
            own = read_ignore_file(folder, FLOWIGNORE)
            state = (False, chain + ((folder, own),) if own is not None else chain)
        self._folders[folder] = state
        return state

    def verdict(self, path: Path | str, is_dir: bool | None = None) -> bool | None:
        """True excluded, False kept by a ``!`` line, None when no ``.flowignore`` speaks of it.
        ``is_dir`` is read from disk (a symlink is not a folder, as for git) when not given."""
        p = os.path.abspath(os.fspath(path))
        parent = os.path.dirname(p)
        if parent == p:
            return None
        excluded, chain = self._folder(parent)
        if excluded:
            return True
        if not chain:
            return None
        if is_dir is None:
            try:
                is_dir = stat.S_ISDIR(os.lstat(p).st_mode)
            except OSError:
                is_dir = False
        return stack_verdict(p, is_dir, chain)

    def excludes(self, path: Path | str, is_dir: bool | None = None) -> bool:
        return self.verdict(path, is_dir) is True


def flowignored(path: Path | str, is_dir: bool | None = None) -> bool:
    """Is ``path`` excluded by a ``.flowignore``? A one-off :class:`FlowIgnore` check."""
    return FlowIgnore().excludes(path, is_dir)
