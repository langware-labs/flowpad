"""Classify projects for cleanup, and remove the ones a person picks.

Two costs, kept apart on purpose:

* :func:`summarize` is what the project picker's scan can afford. It reads the
  rows the list already built and adds one shallow ``listdir`` per project —
  0.065s across 609 candidates, and it agrees with a full recursive walk
  exactly (570 empty either way). The picker already costs seconds; this must
  not add to that.
* :func:`assess_all` is what the cleanup screen shows. It adds a bounded file
  walk and a ``.git`` probe — 0.33s across ~1,200 projects, which is fine on a
  page somebody opened deliberately and is not fine in a path that runs every
  time a picker opens.

Git remotes and dirty state cost a subprocess apiece, so :func:`git_detail`
resolves them for one project on demand.

Nothing in this module runs on its own. There is no sweep, no schedule and no
"clean up while we're here" — the deletions here happen because a person named
a project and pressed a button.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from flow_sdk.config import agent_workspace_root
from flow_sdk.fs_store.path_utils import canonical_posix_path, is_protected_path
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.schema.data_spec.project_cleanup_spec import (
    FILE_COUNT_CAP,
    STALE_AFTER_DAYS,
    WALK_SKIP_DIRS,
    CleanupSummarySpec,
    CleanupVerdict,
    GitInfoSpec,
    HarnessUseSpec,
    ProjectCleanupSpec,
)

logger = logging.getLogger(__name__)

HARNESSES = ("claude", "codex", "copilot")


# ── reading the directory ──────────────────────────────────────────────────


def _iso(ts: float | None) -> Optional[str]:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _as_iso(value: Any) -> Optional[str]:
    """Normalize a timestamp that reaches us in either of two shapes.

    ``modified_at`` is already an ISO string (session-file mtimes), while
    ``last_active_at`` is epoch MILLISECONDS stamped by the entity's ``activate``
    action. Both land in the same field on the spec, so the conversion happens
    here rather than leaving two formats for every reader to sort out.
    """
    if value is None or value == "":
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc).isoformat()
    return str(value)


def _dir_mtime(path: Path) -> Optional[float]:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def has_visible_entry(path: Path) -> bool:
    """Whether the directory holds anything a person would call content.

    Dotfiles do not count: a folder holding only ``.git`` or ``.flow`` is a
    folder a tool created, not one somebody put work in. This shallow check is
    the classifier's file signal, and it is deliberately not a walk — measured
    against a full recursive walk over 609 real directories it returned the
    identical verdict on every one, at 1/25th the cost.
    """
    try:
        return any(not name.startswith(".") for name in os.listdir(path))
    except OSError:
        return False


def count_files(path: Path, cap: int = FILE_COUNT_CAP) -> tuple[int, int, bool]:
    """Walk ``path`` and return ``(file_count, size_bytes, capped)``.

    Stops at ``cap`` files. The count exists to tell "empty" from "a few" from
    "a lot", and past a few hundred the exact number changes no decision — so
    the walk stops rather than spending a minute being precise about a folder
    nobody is going to keep for its file count.
    """
    count = 0
    size = 0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in WALK_SKIP_DIRS and not d.startswith(".")]
        for name in files:
            if name.startswith("."):
                continue
            count += 1
            try:
                size += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
            if count >= cap:
                return cap, size, True
    return count, size, False


def git_detail(cwd: str) -> GitInfoSpec:
    """Resolve remote + dirty for one project. One subprocess pair, on demand.

    Called per row when the screen expands one, never for a whole listing: over
    a thousand projects this would be a thousand process spawns for information
    the reader is looking at one line of.
    """
    path = Path(cwd)
    if not (path / ".git").exists():
        return GitInfoSpec(has_repo=False)

    def _git(*args: str) -> str:
        try:
            done = subprocess.run(
                ["git", "-C", str(path), *args],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        return done.stdout.strip() if done.returncode == 0 else ""

    remote = _git("remote", "get-url", "origin") or None
    # `--porcelain` prints one line per changed path and nothing when clean.
    dirty = bool(_git("status", "--porcelain"))
    return GitInfoSpec(has_repo=True, remote=remote, dirty=dirty)


# ── the verdict ────────────────────────────────────────────────────────────


def _row_sessions(row: dict[str, Any]) -> int:
    try:
        return int(row.get("session_count") or 0)
    except (TypeError, ValueError):
        return 0


def classify(row: dict[str, Any], *, now: Optional[datetime] = None) -> CleanupVerdict:
    """Decide what one project-list row is, using only free signals.

    The four conditions are read as one question — "is there any evidence a
    person used this?" — and any single yes is enough to make it ``ACTIVE``.
    Erring toward keeping is the whole design: a wrong ``ACTIVE`` costs a row in
    a list, a wrong ``EMPTY`` puts somebody's folder in front of a delete button.
    """
    cwd = row.get("cwd") or ""
    path = Path(cwd)
    mtime = _dir_mtime(path)
    if mtime is None:
        # The folder is gone; only the row survives.
        return CleanupVerdict.ORPHANED

    used = (
        _row_sessions(row) > 0
        or bool(row.get("last_active_at"))
        or bool(row.get("worker_types"))
    )
    if used:
        return CleanupVerdict.ACTIVE
    if has_visible_entry(path):
        return CleanupVerdict.STALE

    now = now or datetime.now(timezone.utc)
    age_cutoff = (now - timedelta(days=STALE_AFTER_DAYS)).timestamp()
    return CleanupVerdict.EMPTY if mtime < age_cutoff else CleanupVerdict.STALE


def summarize(rows: Iterable[dict[str, Any]], *, now: Optional[datetime] = None) -> CleanupSummarySpec:
    """Count the cleanup candidates. Shallow only — safe on the picker's path."""
    empty = orphaned = stale = 0
    empty_bytes = 0
    for row in rows:
        verdict = classify(row, now=now)
        if verdict is CleanupVerdict.EMPTY:
            empty += 1
            # An empty folder's own bytes are its directory entry; counting the
            # walk here would undo the point of the shallow pass.
            try:
                empty_bytes += os.path.getsize(row.get("cwd") or "")
            except OSError:
                pass
        elif verdict is CleanupVerdict.ORPHANED:
            orphaned += 1
        elif verdict is CleanupVerdict.STALE:
            stale += 1
    return CleanupSummarySpec(
        empty_count=empty,
        orphaned_count=orphaned,
        stale_count=stale,
        empty_size_bytes=empty_bytes,
    )


# ── harness state ──────────────────────────────────────────────────────────


def _claude_state_paths(cwd: str) -> list[str]:
    """``~/.claude/projects/<dir>`` for this cwd, if Claude knows it.

    Resolved by decoding each directory rather than by encoding the cwd: Claude
    maps ``/``, space and ``_`` all onto ``-``, so the encoding is lossy and not
    invertible. Re-encoding a cwd to find its directory mis-identifies folders
    whose names contain any of those — a dash-decode over the 468 directories on
    the machine this was written against agreed with the truth on 58 of them.
    """
    from flow_sdk.builtin.faas.project_list import _index_claude_dirs_by_cwd

    root = get_instance_settings().user_home / ".claude" / "projects"
    by_cwd = _index_claude_dirs_by_cwd(root)
    match = by_cwd.get(canonical_posix_path(cwd)) or by_cwd.get(cwd)
    return [str(match)] if match else []


def _codex_config_path() -> Path:
    return get_instance_settings().user_home / ".codex" / "config.toml"


def codex_config_has_entry(cwd: str) -> bool:
    """Whether ``~/.codex/config.toml`` registers this project.

    Its own signal, separate from the rollouts: Codex prunes transcripts but
    leaves the ``[projects."<path>"]`` table behind, so a project can be known
    to Codex with no session files left. Without this, "remove from harness"
    would refuse such a project as having nothing to remove — and the entry
    would stay forever.
    """
    config = _codex_config_path()
    if not config.is_file():
        return False
    try:
        return f'[projects."{cwd}"]' in config.read_text(encoding="utf-8")
    except OSError:
        return False


def _codex_state_paths(cwd: str) -> list[str]:
    """Rollout transcripts recorded against this cwd.

    Codex does not shard sessions by project — the cwd lives inside each file's
    ``session_meta`` — so finding them means reading the head of every rollout.
    The config's ``[projects."<path>"]`` table is handled separately by the
    remover, because it is a TOML edit and not a file to delete.
    """
    from flow_sdk.builtin.faas.project_list import _read_codex_session_cwd

    sessions_root = get_instance_settings().codex_sessions_dir
    if not sessions_root.is_dir():
        return []
    target = canonical_posix_path(cwd)
    out: list[str] = []
    for path in sessions_root.rglob("rollout-*.jsonl"):
        session_cwd = _read_codex_session_cwd(path)
        if session_cwd and canonical_posix_path(session_cwd) == target:
            out.append(str(path))
    return out


def _copilot_state_paths(cwd: str) -> list[str]:
    """``~/.copilot/session-state/<id>/`` dirs pointing at this cwd (N per project)."""
    from flow_sdk.builtin.faas.project_list import _read_copilot_workspace_cwd

    root = get_instance_settings().user_home / ".copilot" / "session-state"
    if not root.is_dir():
        return []
    target = canonical_posix_path(cwd)
    out: list[str] = []
    for workspace in root.glob("*/workspace.yaml"):
        workspace_cwd = _read_copilot_workspace_cwd(workspace)
        if workspace_cwd and canonical_posix_path(workspace_cwd) == target:
            out.append(str(workspace.parent))
    return out


_STATE_READERS = {
    "claude": _claude_state_paths,
    "codex": _codex_state_paths,
    "copilot": _copilot_state_paths,
}


def harness_uses(row: dict[str, Any], *, with_paths: bool = False) -> list[HarnessUseSpec]:
    """Per-harness session counts for one row, optionally with their state paths.

    ``with_paths`` is off by default because resolving them means scanning the
    harness stores, which is per-project work — the listing shows counts, and the
    paths are resolved when a person is about to delete them.
    """
    uses: list[HarnessUseSpec] = []
    cwd = row.get("cwd") or ""
    for harness in HARNESSES:
        try:
            count = int(row.get(f"{harness}_session_count") or 0)
        except (TypeError, ValueError):
            count = 0
        claimed = bool(row.get(harness))
        if not count and not claimed:
            continue
        uses.append(
            HarnessUseSpec(
                harness=harness,
                session_count=count,
                last_session_at=_as_iso(row.get("modified_at")),
                state_paths=_STATE_READERS[harness](cwd) if with_paths else [],
            )
        )
    return uses


def assess(row: dict[str, Any], *, now: Optional[datetime] = None) -> ProjectCleanupSpec:
    """One project, with the detail the cleanup screen shows."""
    cwd = row.get("cwd") or ""
    path = Path(cwd)
    verdict = classify(row, now=now)
    if verdict is CleanupVerdict.ORPHANED:
        count, size, capped = 0, 0, False
        git: Optional[GitInfoSpec] = None
    else:
        count, size, capped = count_files(path)
        git = GitInfoSpec(has_repo=(path / ".git").exists())
    return ProjectCleanupSpec(
        project_id=str(row.get("id") or ""),
        name=str(row.get("name") or ""),
        cwd=cwd,
        verdict=verdict,
        file_count=count,
        size_bytes=size,
        file_count_capped=capped,
        dir_modified_at=_iso(_dir_mtime(path)),
        modified_at=_as_iso(row.get("modified_at")),
        last_active_at=_as_iso(row.get("last_active_at")),
        harnesses=harness_uses(row),
        git=git,
    )


def assess_all(rows: Iterable[dict[str, Any]], *, now: Optional[datetime] = None) -> list[ProjectCleanupSpec]:
    """The cleanup screen's payload, worst-first.

    Ordered so the rows a person is most likely to act on are the rows they see:
    orphaned (no folder to lose), then empty, then everything else.
    """
    order = {
        CleanupVerdict.ORPHANED: 0,
        CleanupVerdict.EMPTY: 1,
        CleanupVerdict.STALE: 2,
        CleanupVerdict.ACTIVE: 3,
    }
    specs = [assess(row, now=now) for row in rows]
    specs.sort(key=lambda s: (order[s.verdict], -s.file_count, s.name.lower()))
    return specs


# ── removal ────────────────────────────────────────────────────────────────


class CleanupRefused(Exception):
    """A guard said no. Carries the reason the UI shows verbatim."""


def _guard(cwd: str) -> Path:
    """Refuse anything that is not a deletable project directory.

    Fails closed on every unclear case: ``is_protected_path`` already protects
    filesystem roots, the user home and the workspace container itself, and the
    containment check below means a bad ``cwd`` cannot reach outside the
    workspace even if a caller supplies one directly.
    """
    if not cwd:
        raise CleanupRefused("No path on this project")
    path = Path(cwd)
    if is_protected_path(path):
        raise CleanupRefused(f"{cwd} is a protected path")
    workspace = agent_workspace_root()
    try:
        resolved = path.resolve()
    except OSError as exc:
        raise CleanupRefused(f"Cannot resolve {cwd}") from exc
    workspace_resolved = workspace.resolve()
    if resolved == workspace_resolved:
        # `is_protected_path` also covers this, but only for the REAL configured
        # workspace. Naming it here means the containment check cannot be the
        # only thing standing between a caller and the whole workspace.
        raise CleanupRefused(f"{cwd} is the workspace root")
    if not resolved.is_relative_to(workspace_resolved):
        raise CleanupRefused(f"{cwd} is outside {workspace}")
    return resolved


def remove_from_harness(row: dict[str, Any]) -> dict[str, Any]:
    """Delete this project's harness state. The folder and the row are untouched.

    Refused when there is no state to remove, rather than reported as a success
    that did nothing — which is the case for every empty workspace folder, since
    a directory a harness ran in but never opened a session in leaves nothing
    behind.
    """
    cwd = row.get("cwd") or ""
    uses = harness_uses(row, with_paths=True)
    paths = [p for use in uses for p in use.state_paths]
    has_config_entry = codex_config_has_entry(cwd)
    if not paths and not has_config_entry:
        raise CleanupRefused("No harness state for this project")

    removed: list[str] = []
    for target in paths:
        node = Path(target)
        try:
            if node.is_dir():
                shutil.rmtree(node)
            elif node.exists():
                node.unlink()
            else:
                continue
        except OSError as exc:
            logger.warning("cleanup: could not remove harness state %s: %s", target, exc)
            continue
        removed.append(target)

    config_dropped = _drop_codex_config_entry(cwd)
    return {"cwd": cwd, "removed_paths": removed, "codex_config_entry_removed": config_dropped}


def _drop_codex_config_entry(cwd: str) -> bool:
    """Remove the ``[projects."<cwd>"]` table from ``~/.codex/config.toml``.

    A line-level edit rather than a parse-and-rewrite: the file is the user's,
    it carries their comments and formatting, and a round-trip through a TOML
    writer would silently reformat all of it to delete two lines.
    """
    config = _codex_config_path()
    if not config.is_file():
        return False
    try:
        lines = config.read_text(encoding="utf-8").splitlines(keepends=True)
    except OSError:
        return False

    header = f'[projects."{cwd}"]'
    out: list[str] = []
    dropping = False
    dropped = False
    for line in lines:
        stripped = line.strip()
        if stripped == header:
            dropping = True
            dropped = True
            continue
        # Any following table header ends the one being dropped.
        if dropping and stripped.startswith("["):
            dropping = False
        if not dropping:
            out.append(line)
    if not dropped:
        return False
    try:
        config.write_text("".join(out), encoding="utf-8")
    except OSError as exc:
        logger.warning("cleanup: could not rewrite %s: %s", config, exc)
        return False
    return True


def move_to_trash(path: Path) -> str:
    """Send ``path`` to the desktop Trash. Returns which mechanism was used.

    ``send2trash`` is preferred because it produces a real, restorable Trash
    entry on every platform. The fallback is a plain move into ``~/.Trash``,
    which on macOS puts the folder where the user expects to find it even though
    Finder's "Put Back" will not know where it came from. The caller reports the
    mechanism so the confirmation text can stay honest about what happened.
    """
    try:
        from send2trash import send2trash  # noqa: PLC0415 — optional dependency

        send2trash(str(path))
        return "trash"
    except Exception:  # ImportError, or a platform trash that refused
        trash_dir = Path(get_instance_settings().user_home) / ".Trash"
        try:
            trash_dir.mkdir(parents=True, exist_ok=True)
            target = trash_dir / path.name
            suffix = 1
            while target.exists():
                target = trash_dir / f"{path.name} {suffix}"
                suffix += 1
            shutil.move(str(path), str(target))
            return "trash_fallback"
        except OSError as exc:
            raise CleanupRefused(f"Could not move {path} to Trash: {exc}") from exc


def delete_permanently(row: dict[str, Any]) -> dict[str, Any]:
    """Harness state, then the folder to Trash. The entity row is the caller's job.

    Order matters: the workspace scan mints a row for every directory it finds,
    so removing a row while its folder is still there produces a project that
    comes back on the next picker open. The folder goes first.
    """
    cwd = row.get("cwd") or ""
    result: dict[str, Any] = {"cwd": cwd, "removed_paths": [], "trashed": False, "mechanism": None}

    try:
        harness = remove_from_harness(row)
        result["removed_paths"] = harness["removed_paths"]
        result["codex_config_entry_removed"] = harness["codex_config_entry_removed"]
    except CleanupRefused:
        # No harness state is the normal case for an empty folder, not a failure.
        pass

    path = Path(cwd)
    if not path.exists():
        # Orphaned row: nothing on disk, so the row removal is the whole job.
        return result

    resolved = _guard(cwd)
    result["mechanism"] = move_to_trash(resolved)
    result["trashed"] = True
    return result


__all__ = [
    "CleanupRefused",
    "assess",
    "codex_config_has_entry",
    "assess_all",
    "classify",
    "count_files",
    "delete_permanently",
    "git_detail",
    "harness_uses",
    "has_visible_entry",
    "move_to_trash",
    "remove_from_harness",
    "summarize",
]
