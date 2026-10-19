"""TreeWalker — spec §1. The descent is ``fs_store.indexer.walk.walk_entries``,
the same one ``gitignore_walk`` runs; this module only turns a ``WalkPolicy``
into that walk's ``skip`` decision and its tuples into ``WalkEntry`` values."""

from __future__ import annotations

from pathlib import Path, PurePath
from typing import Iterator

from flow_sdk.diskio.contract import StreamEnd, WalkEntry, WalkPolicy
from flow_sdk.diskio.python._stream import unreadable, with_end
from flow_sdk.fs_store.gitignore import _FORCE_INCLUDE, _WALK_IGNORED, GitignoreStack, stack_ignores
from flow_sdk.fs_store.indexer.walk import SkipFn, walk_entries

#: ``gitignore.py``'s ``.claude/worktrees`` skip, as data.
_SKIP_SEGMENTS: tuple[tuple[str, str], ...] = ((".claude", "worktrees"),)


def walk_policy(
    *, gitignore: bool = True, denylist: bool = True, file_exts: tuple[str, ...] | None = None,
) -> WalkPolicy:
    """The policy ``gitignore_walk(root, gitignore=, denylist=)`` walks under —
    the three lists filled from ``fs_store/gitignore.py``, never copied into the
    contract. With ``gitignore=True`` the denylist applies whatever ``denylist``
    says, exactly as ``is_ignored`` consults it first."""
    listed = gitignore or denylist
    return WalkPolicy(
        gitignore=gitignore,
        file_exts=file_exts,
        deny_basenames=tuple(sorted(_WALK_IGNORED)) if listed else (),
        skip_segments=_SKIP_SEGMENTS if listed else (),
        force_include=tuple(sorted(_FORCE_INCLUDE)) if gitignore else (),
    )


def _skip_for(root: Path, policy: WalkPolicy) -> SkipFn | None:
    """The per-entry decision of §1, steps 2 and 3, from the policy's lists."""
    deny = frozenset(policy.deny_basenames)
    segments = frozenset(policy.skip_segments)
    force = frozenset(policy.force_include)

    def denied(path: Path) -> bool:
        if path.name in deny:
            return True
        if segments:
            parts = path.parts
            return any((parts[i], parts[i + 1]) in segments for i in range(len(parts) - 1))
        return False

    def forced(path: Path) -> bool:
        p = path
        while True:
            if p.name in force:
                return True
            if p == root or p.parent == p:
                return False
            p = p.parent

    if policy.gitignore:
        def skip(path: Path, is_dir: bool, stack: GitignoreStack) -> bool:
            if denied(path):
                return True
            if force and forced(path):
                return False
            return stack_ignores(path, is_dir, stack)
        return skip
    if deny or segments:
        return lambda path, _is_dir, _stack: denied(path)
    return None


def iter_walk(
    root: Path, policy: WalkPolicy,
) -> Iterator[tuple[Path, list[Path], list[Path], OSError | None]]:
    """``walk_entries`` under ``policy``, files narrowed to ``file_exts``."""
    exts = None if policy.file_exts is None else frozenset(ext.lower() for ext in policy.file_exts)
    walk = walk_entries(
        root, gitignore=policy.gitignore, include_files=exts is None or bool(exts),
        skip=_skip_for(root, policy),
    )
    if not exts:
        yield from walk
        return
    for dir_path, subdirs, files, error in walk:
        yield dir_path, subdirs, [f for f in files if PurePath(f.name).suffix.lower() in exts], error


class PyTreeWalker:
    def walk(self, root: str, policy: WalkPolicy, *, threads: int = 1) -> Iterator[WalkEntry | StreamEnd]:
        return with_end(self._entries(root, policy))

    @staticmethod
    def _entries(root: str, policy: WalkPolicy) -> Iterator[WalkEntry]:
        for dir_path, subdirs, files, error in iter_walk(Path(root), policy):
            yield WalkEntry(
                dir=str(dir_path),
                subdirs=tuple(p.name for p in subdirs),
                files=tuple(p.name for p in files),
                error=None if error is None else unreadable(str(dir_path), error),
            )
