"""Is a path kept out of git? — asked of git, never read off a ``.gitignore`` by hand.

Only git resolves wildcards, a global excludes file, ``.git/info/exclude``, nested ignore files and
negations, so every answer here is git's own. Three questions, one per caller:

* :func:`ignore_status` — is THIS path (a file or a folder) excluded? Read-only.
* :func:`ensure_ignored` — make it excluded: append it to the ``.gitignore`` beside it, then ask git
  again (a later negation can defeat the line). Writes only inside a git work tree.
* :func:`ignored_under` — which paths under a root does git exclude? The set a copy that leaves the
  machine must think twice about.

Outside a work tree there is no history to leak into: the status says so, nothing is written, and
nothing is excluded.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from flow_sdk.utils import git as _git

logger = logging.getLogger(__name__)

GITIGNORE_FILENAME = ".gitignore"

NO_DIR = "no-project-dir"
NOT_A_REPO = "not-a-repo"
IGNORED = "ignored"
NOT_IGNORED = "not-ignored"
TRACKED = "tracked"
GIT_FAILURE = "git-failure"


def _inside_work_tree(cwd: str) -> bool:
    inside = _git._run_git(["git", "rev-parse", "--is-inside-work-tree"], cwd, timeout=10)
    return inside.returncode == 0 and inside.stdout.strip() == "true"


def _parent(path: Path) -> Optional[Path]:
    parent = path.parent
    return parent if parent.is_dir() else None


def _probe_name(path: Path) -> str:
    """``path`` as named from its parent: a folder carries a trailing ``/`` so a folder-only pattern
    (``/examples/``) matches it."""
    return f"{path.name}/" if path.is_dir() else path.name


def ignore_status(path: Path | str) -> str:
    """One of the codes above for ``path``. **Read-only.**

    ``TRACKED`` wins over everything: ignore rules do not apply to what git already tracks, so a
    tracked file (or a folder holding one) is committable whatever ``.gitignore`` says."""
    p = Path(path)
    parent = _parent(p)
    if parent is None:
        return NO_DIR
    cwd = str(parent)
    try:
        if not _inside_work_tree(cwd):
            return NOT_A_REPO
        tracked = _git._run_git(["git", "ls-files", "--", p.name], cwd, timeout=10)
        if tracked.returncode == 0 and tracked.stdout.strip():
            return TRACKED
        # check-ignore: 0 = ignored, 1 = not ignored, anything else = failure.
        probe = _git._run_git(["git", "check-ignore", "-q", "--", _probe_name(p)], cwd, timeout=10)
    except Exception as e:  # noqa: BLE001
        logger.warning("[git-ignore] probe failed for %s: %s", p, e)
        return GIT_FAILURE
    if probe.returncode == 0:
        return IGNORED
    if probe.returncode == 1:
        return NOT_IGNORED
    logger.warning("[git-ignore] check-ignore exited %s for %s", probe.returncode, p)
    return GIT_FAILURE


def append_line(gitignore: Path, line: str) -> None:
    """``line`` appended to ``gitignore`` unless it is already there, newline-safe."""
    existing = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    if line in {ln.strip() for ln in existing.splitlines()}:
        return
    sep = "" if (existing == "" or existing.endswith("\n")) else "\n"
    gitignore.write_text(f"{existing}{sep}{line}\n", encoding="utf-8")


def ensure_ignored(path: Path | str) -> str:
    """Exclude ``path`` from git and return the VERIFIED code.

    Appends ``/<name>/`` for a folder, ``<name>`` for a file, to the ``.gitignore`` beside it — a
    nested ``.gitignore`` travels with the folder that holds it. Only when git says the path is
    ``NOT_IGNORED``: a tracked path stays tracked (a line cannot untrack it — the caller refuses),
    and outside a repo nothing is written."""
    p = Path(path)
    status = ignore_status(p)
    if status != NOT_IGNORED:
        return status
    line = f"/{p.name}/" if p.is_dir() else p.name
    try:
        append_line(p.parent / GITIGNORE_FILENAME, line)
    except OSError as e:
        logger.warning("[git-ignore] could not write .gitignore beside %s: %s", p, e)
        return GIT_FAILURE
    return ignore_status(p)


def ignored_under(root: Path | str) -> set[Path]:
    """The paths under ``root`` git excludes, as absolute paths; a whole excluded folder is ONE
    entry (git's ``--directory``). ``{root}`` when ``root`` itself is excluded. Empty outside a work
    tree or when git cannot answer — a copy is then what it was before this existed."""
    r = Path(root)
    if not r.is_dir():
        return set()
    cwd = str(r)
    try:
        if not _inside_work_tree(cwd):
            return set()
        listed = _git._run_git(
            ["git", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], cwd, timeout=30
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("[git-ignore] listing ignored paths under %s failed: %s", r, e)
        return set()
    if listed.returncode != 0:
        return set()
    found: set[Path] = set()
    for entry in listed.stdout.split("\0"):
        if not entry:
            continue
        if entry in ("./", "."):
            return {r.resolve()}
        found.add((r / entry.rstrip("/")).resolve())
    return found


def is_under(path: Path, ignored: set[Path]) -> bool:
    """Whether ``path`` is one of ``ignored`` or inside one of them (never, for an empty set)."""
    if not ignored:
        return False
    p = path.resolve()
    return any(p == i or i in p.parents for i in ignored)


__all__ = [
    "GITIGNORE_FILENAME", "GIT_FAILURE", "IGNORED", "NOT_A_REPO", "NOT_IGNORED", "NO_DIR", "TRACKED",
    "append_line", "ensure_ignored", "ignore_status", "ignored_under", "is_under",
]
