"""CompositeFsopFilter — cheap → expensive cascade for `awatch(watch_filter=...)`.

Composition order (each layer can drop the event before later layers run):

1. `pathspec.GitIgnoreSpec` over `trigger.ignore_patterns` — extra patterns
   declared on the trigger config. Applied even when respect_gitignore=False.
2. Nested `.gitignore` stack — only when `trigger.respect_gitignore=True`.
   Reuses `flow_sdk/fs_store/indexer/gitignore.py` (_WALK_IGNORED fast-path +
   GitIgnoreSpec stack with last-match-wins semantics).
3. Path-shape gate: relative_to(watched), single-segment for non-recursive
   folder mode, `watch_glob` fnmatch — preserves the previous behavior so
   FSEvents-emitted parent-dir events don't slip through.

We deliberately do NOT layer `watchfiles.DefaultFilter` — its hardcoded
basename denylist (`.git`, `__pycache__`, `*.pyc`, etc.) silently drops events
for paths the user may have explicitly configured to watch (e.g. a trigger on
`/some/repo/.git/HEAD` to detect ref changes). Users wanting that denylist
opt in via `ignore_patterns` or `respect_gitignore=True`.

All matching is on POSIX-form paths so patterns written `node_modules/`,
`build/`, `*.log` work identically on macOS / Linux / Windows.

# pending improvement: hot-reload nested .gitignore when the file itself
# changes mid-run. https://github.com/cpburnz/python-pathspec/issues/64
# pending improvement: polling fallback (PollingObserver-style) for network
# filesystems / WSL / FUSE where notify-rs is unreliable.
# https://github.com/zed-industries/zed/issues/51340
"""
from __future__ import annotations

import fnmatch
import logging
from pathlib import Path
from typing import Any

from pathspec import GitIgnoreSpec

from flow_sdk.fs_store.indexer.gitignore import (
    GitignoreStack,
    is_ignored,
    load_gitignore_stack,
    push_gitignore,
)

_log = logging.getLogger(__name__)

# Bound the gitignore-discovery walk so a misconfigured root (`/`) doesn't
# burn boot time. We still prune _WALK_IGNORED dirs while walking.
_GITIGNORE_DISCOVERY_MAX_DIRS = 5000


class CompositeFsopFilter:
    """`awatch(watch_filter=...)`-compatible callable.

    Stateless after construction: gitignore stack is built once at watch-task
    spawn time, then reused for the lifetime of the awatch task. When a
    trigger config changes (watch_path / respect_gitignore / ignore_patterns),
    `FSOpWatcher.on_trigger_saved` cancels and respawns the task, rebuilding
    the filter from scratch.
    """

    def __init__(self, *, trigger: Any, watched_path: Path) -> None:
        self._trigger = trigger
        self._recursive = bool(getattr(trigger, "recursive", False))
        self._glob_pattern = getattr(trigger, "watch_glob", None)

        try:
            self._target_resolved = watched_path.resolve()
        except OSError:
            self._target_resolved = watched_path
        self._is_folder = self._target_resolved.is_dir() or self._recursive

        # Layer 1 — trigger-config ignore patterns.
        patterns = list(getattr(trigger, "ignore_patterns", None) or [])
        self._extra_spec: GitIgnoreSpec | None = (
            GitIgnoreSpec.from_lines(patterns) if patterns else None
        )

        # Layer 2 — nested .gitignore stack.
        respect = bool(getattr(trigger, "respect_gitignore", False))
        self._gitignore_root: Path | None = None
        self._gitignore_stack: GitignoreStack = []
        if respect and self._is_folder:
            try:
                self._gitignore_root = self._target_resolved
                self._gitignore_stack = self._discover_gitignores(self._target_resolved)
            except Exception:
                _log.exception(
                    "Trigger %s: gitignore discovery failed; proceeding without it",
                    getattr(trigger, "name", "?"),
                )
                self._gitignore_stack = []

    @staticmethod
    def _discover_gitignores(root: Path) -> GitignoreStack:
        """Walk `root` collecting .gitignore specs, pruning noise dirs via
        `_WALK_IGNORED` so we never descend into a 50k-file node_modules just
        to find a .gitignore inside it."""
        import os

        from flow_sdk.fs_store.indexer.gitignore import _WALK_IGNORED

        stack = load_gitignore_stack(root)
        seen = 1
        for dirpath, dirnames, _ in os.walk(root, followlinks=False):
            # Prune in-place so os.walk skips noisy subtrees entirely.
            dirnames[:] = [d for d in dirnames if d not in _WALK_IGNORED]
            seen += len(dirnames)
            if seen > _GITIGNORE_DISCOVERY_MAX_DIRS:
                _log.warning(
                    "gitignore discovery hit %d-dir cap at %s; nested .gitignore beyond cap not honored",
                    _GITIGNORE_DISCOVERY_MAX_DIRS, root,
                )
                break
            for d in dirnames:
                push_gitignore(stack, Path(dirpath) / d)
        return stack

    def __call__(self, change_type: Any, raw_path: str) -> bool:
        p = Path(raw_path)
        try:
            resolved = p.resolve()
        except OSError:
            return False

        # Layer 1 — trigger-config ignore_patterns. Pattern matching is
        # relative to the watched root so users can write 'build/', 'dist/'.
        if self._extra_spec is not None:
            try:
                rel = resolved.relative_to(self._target_resolved)
                rel_posix = rel.as_posix()
            except ValueError:
                rel_posix = resolved.as_posix()
            if self._extra_spec.match_file(rel_posix):
                return False
            # Dir-style patterns (trailing /) need an explicit candidate.
            try:
                if resolved.is_dir() and self._extra_spec.match_file(rel_posix + "/"):
                    return False
            except OSError:
                pass

        # Layer 2 — nested .gitignore stack.
        if self._gitignore_stack and self._gitignore_root is not None:
            try:
                is_dir = resolved.is_dir()
            except OSError:
                is_dir = False
            if is_ignored(resolved, is_dir, self._gitignore_stack, self._gitignore_root):
                return False

        # Layer 3 — path-shape gate (same as the previous _match impl).
        if self._is_folder:
            try:
                rel = resolved.relative_to(self._target_resolved)
            except ValueError:
                return False
            if not self._recursive:
                # macOS FSEvents reports the parent dir itself + subdir events;
                # restrict to single-segment file paths only.
                if len(rel.parts) != 1 or resolved.is_dir():
                    return False
            if self._glob_pattern and not fnmatch.fnmatch(p.name, self._glob_pattern):
                return False
            return True
        return resolved == self._target_resolved
