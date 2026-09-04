"""Classify projects for cleanup, and remove the harness state behind them.

Two costs, kept apart on purpose:

* :func:`summarize` is what the project picker's scan can afford. It reads the
  rows the list already built and adds one shallow ``scandir`` per project —
  measured at 0.065s across 609 candidates, and it agrees with a full recursive
  walk exactly (570 empty either way). The picker already costs seconds; this
  must not add to that.
* :func:`assess_all` is what the cleanup screen shows. It adds a bounded file
  walk and a ``.git`` probe — 0.33s across ~1,200 projects, which is fine on a
  page somebody opened deliberately and is not fine in a path that runs every
  time a picker opens.

Git remotes and dirty state cost a subprocess apiece, so :func:`git_detail`
resolves them for one project on demand.

**Harness state is indexed once, not per project.** Each store answers "which
projects do I know about" only by being read whole — Claude's directory names
are lossy, Codex keeps the cwd inside each rollout file, Copilot one directory
per session. Resolving that per project turned a fifty-project delete into
fifty full rescans (~21s and ~57,000 file opens on the machine this was written
against), so :class:`HarnessIndex` builds all three maps once and every lookup
after that is a dict hit.

Nothing here runs on its own. There is no sweep, no schedule and no "clean up
while we're here" — the deletions happen because a person named a project and
pressed a button. Removing the project ROW is deliberately not this module's
job either: that is ``Project._delete_with_children``, which owns the cascade
guards, and re-deriving them here is how the shared ``@local`` compute node
gets deleted by accident.
"""

from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

try:
    import tomllib as _tomllib  # type: ignore[import-not-found]
except ImportError:  # Python 3.10 — the repo's floor
    import tomli as _tomllib  # type: ignore[import-not-found,no-redef]

from flow_sdk.config import agent_workspace_root
from flow_sdk.fs_store.indexer.gitignore import is_denylisted
from flow_sdk.fs_store.path_utils import (
    canonical_posix_path,
    is_path_under,
    is_protected_path,
)
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.schema.data_spec.project_cleanup_spec import (
    FILE_COUNT_CAP,
    STALE_AFTER_DAYS,
    CleanupSummarySpec,
    CleanupVerdict,
    GitInfoSpec,
    HarnessUseSpec,
    ProjectCleanupSpec,
)
from flow_sdk.utils.serialization import epoch_to_iso_utc

logger = logging.getLogger(__name__)

HARNESSES = ("claude", "codex", "copilot")


# ── reading the directory ──────────────────────────────────────────────────


def _iso_from_seconds(ts: float | None) -> Optional[str]:
    """A ``st_mtime`` as canonical UTC ISO."""
    return None if ts is None else epoch_to_iso_utc(ts)


def _iso_from_row(value: Any) -> Optional[str]:
    """Normalize a project-list timestamp, which arrives in two shapes.

    ``modified_at`` is already an ISO string (session-file mtimes), while
    ``last_active_at`` is epoch MILLISECONDS stamped by the entity's ``activate``
    action. Anything else is dropped rather than coerced: a non-ISO string in a
    field typed as ISO fails somewhere further away and harder.
    """
    if value is None or value == "":
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return epoch_to_iso_utc(value / 1000.0)
    return None


def _stat_or_none(path: Path) -> Optional[os.stat_result]:
    try:
        return path.stat()
    except OSError:
        return None


def has_visible_entry(path: Path) -> bool:
    """Whether the directory holds anything a person would call content.

    Dotfiles do not count: a folder holding only ``.git`` or ``.flow`` is one a
    tool created, not one somebody put work in. Deliberately shallow — measured
    against a full recursive walk over 609 real directories it returned the
    identical verdict on every one, at a twenty-fifth of the cost. ``scandir``
    rather than ``listdir`` so it stops at the first visible entry instead of
    materializing every name first.
    """
    try:
        with os.scandir(path) as entries:
            return any(not entry.name.startswith(".") for entry in entries)
    except OSError:
        return False


def count_files(path: Path, cap: int = FILE_COUNT_CAP) -> tuple[int, int, bool]:
    """Walk ``path`` and return ``(file_count, size_bytes, capped)``.

    Stops at ``cap`` files. The count exists to tell "empty" from "a few" from
    "a lot", and past a few hundred the exact number changes no decision — so
    the walk stops rather than spending a minute being precise about a folder
    nobody is keeping for its file count.

    Skipping goes through the shared ``is_denylisted``, so ``venv``, ``build``,
    ``coverage`` and the rest of the tree's ignore policy are excluded here too.
    A private skip set was a six-entry subset of it, which counted a stray
    ``venv`` as user content and read an otherwise-empty folder as holding work.
    Directory symlinks are never followed — the shared walk does not either, and
    following them can loop or double-count.
    """
    count = 0
    size = 0
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    if entry.name.startswith("."):
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if not is_denylisted(Path(entry.path)):
                                stack.append(Path(entry.path))
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        count += 1
                        size += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
                    if count >= cap:
                        return cap, size, True
        except OSError:
            continue
    return count, size, False


def git_detail(cwd: str) -> GitInfoSpec:
    """Resolve remote + dirty for one project. Two git probes, on demand.

    Called per row when the screen expands one, never for a whole listing: over
    a thousand projects this would be a thousand process spawns for information
    the reader is looking at one line of. ``resolved`` is what tells a reader
    that ``remote=None`` means "no remote" rather than "not looked up yet" —
    the bulk pass leaves it False, and conflating the two shipped as a bug where
    every repo rendered remote-less and clean.
    """
    from flow_sdk.utils.git import _sync, git_remote_url  # noqa: PLC0415

    path = Path(cwd)
    if not (path / ".git").exists():
        return GitInfoSpec(has_repo=False, resolved=True)
    return GitInfoSpec(
        has_repo=True,
        remote=git_remote_url(str(path)) or None,
        # `--porcelain` prints one line per changed path and nothing when clean.
        dirty=bool(_sync(str(path), "status", "--porcelain")),
        resolved=True,
    )


# ── the verdict ────────────────────────────────────────────────────────────


def _int_field(row: dict[str, Any], key: str) -> int:
    try:
        return int(row.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def classify(
    row: dict[str, Any],
    *,
    now: Optional[datetime] = None,
    stat: Optional[os.stat_result] = None,
) -> CleanupVerdict:
    """Decide what one project-list row is, using only free signals.

    The conditions are read as one question — "is there any evidence a person
    used this?" — and any single yes makes it ``ACTIVE``. Erring toward keeping
    is the whole design: a wrong ``ACTIVE`` costs a row in a list, a wrong
    ``EMPTY`` puts somebody's folder in front of a delete button.

    ``stat`` lets a caller that already stat'd the directory pass it in rather
    than paying for a second one.
    """
    cwd = row.get("cwd") or ""
    path = Path(cwd)
    info = stat if stat is not None else _stat_or_none(path)
    if info is None:
        # The folder is gone; only the row survives.
        return CleanupVerdict.ORPHANED

    used = (
        _int_field(row, "session_count") > 0
        or bool(row.get("last_active_at"))
        or bool(row.get("worker_types"))
    )
    if used:
        return CleanupVerdict.ACTIVE
    if has_visible_entry(path):
        return CleanupVerdict.STALE

    now = now or datetime.now(timezone.utc)
    age_cutoff = (now - timedelta(days=STALE_AFTER_DAYS)).timestamp()
    return CleanupVerdict.EMPTY if info.st_mtime < age_cutoff else CleanupVerdict.STALE


def _count_verdicts(verdicts: Iterable[CleanupVerdict]) -> CleanupSummarySpec:
    empty = orphaned = stale = 0
    for verdict in verdicts:
        if verdict is CleanupVerdict.EMPTY:
            empty += 1
        elif verdict is CleanupVerdict.ORPHANED:
            orphaned += 1
        elif verdict is CleanupVerdict.STALE:
            stale += 1
    return CleanupSummarySpec(empty_count=empty, orphaned_count=orphaned, stale_count=stale)


def summarize(rows: Iterable[dict[str, Any]], *, now: Optional[datetime] = None) -> CleanupSummarySpec:
    """Count the cleanup candidates. Shallow only — safe on the picker's path."""
    return _count_verdicts(classify(row, now=now) for row in rows)


# ── harness state ──────────────────────────────────────────────────────────


def _canonical(path: str) -> str:
    try:
        return canonical_posix_path(path)
    except (OSError, ValueError):
        return path


def _claude_map() -> dict[str, list[str]]:
    """``{cwd: [~/.claude/projects/<dir>]}``.

    Built by decoding each directory rather than by encoding the cwd: Claude
    maps ``/``, space and ``_`` all onto ``-``, so the encoding is lossy and not
    invertible. Re-encoding a cwd to find its directory mis-identifies any
    folder whose name contains one of those — a dash-decode over the 468
    directories on the machine this was written against agreed with the truth on
    58 of them.
    """
    from flow_sdk.builtin.faas.project_list import _index_claude_dirs_by_cwd  # noqa: PLC0415

    root = get_instance_settings().claude_projects_dir
    return {_canonical(cwd): [str(directory)] for cwd, directory in _index_claude_dirs_by_cwd(root).items()}


def _codex_map() -> dict[str, list[str]]:
    """``{cwd: [rollout files]}``.

    Codex does not shard sessions by project — the cwd lives inside each file's
    ``session_meta`` — so this is one pass over the whole rollout store. The
    config's ``[projects."<path>"]`` table is a separate signal, handled by
    :func:`codex_config_entry`.
    """
    from flow_sdk.builtin.faas.project_list import _read_codex_session_cwd  # noqa: PLC0415

    sessions_root = get_instance_settings().codex_sessions_dir
    out: dict[str, list[str]] = {}
    if not sessions_root.is_dir():
        return out
    for path in sessions_root.rglob("rollout-*.jsonl"):
        session_cwd = _read_codex_session_cwd(path)
        if session_cwd:
            out.setdefault(_canonical(session_cwd), []).append(str(path))
    return out


def _copilot_map() -> dict[str, list[str]]:
    """``{cwd: [session-state dirs]}`` — N directories per project."""
    from flow_sdk.builtin.faas.project_list import _read_copilot_workspace_cwd  # noqa: PLC0415

    root = get_instance_settings().copilot_session_state_dir
    out: dict[str, list[str]] = {}
    if not root.is_dir():
        return out
    for workspace in root.glob("*/workspace.yaml"):
        workspace_cwd = _read_copilot_workspace_cwd(workspace)
        if workspace_cwd:
            out.setdefault(_canonical(workspace_cwd), []).append(str(workspace.parent))
    return out


@dataclass
class HarnessIndex:
    """Every harness's state paths, keyed by canonical cwd. Built once.

    Each map is one full read of that harness's store, so building this costs
    what a SINGLE project lookup used to. Callers that touch more than one
    project — which is every mutation, since the actions take a list — build it
    once and hand it down.
    """

    claude: dict[str, list[str]] = field(default_factory=dict)
    codex: dict[str, list[str]] = field(default_factory=dict)
    copilot: dict[str, list[str]] = field(default_factory=dict)

    @classmethod
    def build(cls) -> "HarnessIndex":
        return cls(claude=_claude_map(), codex=_codex_map(), copilot=_copilot_map())

    def paths_for(self, harness: str, cwd: str) -> list[str]:
        if not cwd:
            return []
        return getattr(self, harness, {}).get(_canonical(cwd), [])

    def any_state(self, cwd: str) -> list[str]:
        return [path for harness in HARNESSES for path in self.paths_for(harness, cwd)]


def harness_uses(row: dict[str, Any]) -> list[HarnessUseSpec]:
    """Per-harness session counts for one row, from the listing's own numbers.

    No filesystem work: state paths are resolved from a :class:`HarnessIndex` at
    the moment something is about to be deleted, not carried on every row of a
    listing that never reads them.
    """
    uses: list[HarnessUseSpec] = []
    for harness in HARNESSES:
        count = _int_field(row, f"{harness}_session_count")
        if not count and not row.get(harness):
            continue
        uses.append(
            HarnessUseSpec(
                harness=harness,
                session_count=count,
                last_session_at=_iso_from_row(row.get("modified_at")),
            )
        )
    return uses


# ── codex config ───────────────────────────────────────────────────────────


def codex_config_entry(cwd: str) -> Optional[str]:
    """The exact ``[projects."<key>"]`` key registering this cwd, or None.

    Parsed as TOML rather than matched as a string, because the reader
    that decides a project is registered (``_read_codex_projects_from_config``)
    parses too: a key written in any other legal TOML spelling would otherwise
    read as "has harness state" and then be un-removable — exactly the failure
    this feature exists to end.
    """
    config = get_instance_settings().codex_config_path
    if not config.is_file():
        return None
    try:
        data = _tomllib.loads(config.read_text(encoding="utf-8"))
    except (OSError, _tomllib.TOMLDecodeError):
        return None
    target = _canonical(cwd)
    for key in data.get("projects") or {}:
        if key == cwd or _canonical(key) == target:
            return key
    return None


def drop_codex_config_entry(cwd: str) -> bool:
    """Remove this cwd's ``[projects."<key>"]`` table from ``~/.codex/config.toml``.

    A line-level edit rather than a parse-and-rewrite: the file is the user's,
    it carries their comments and formatting, and a round-trip through a TOML
    writer would reformat all of it to delete two lines. The KEY comes from the
    parser (:func:`codex_config_entry`) so the write is driven by the same
    understanding as the read; only the excision is textual.
    """
    key = codex_config_entry(cwd)
    if key is None:
        return False
    config = get_instance_settings().codex_config_path
    try:
        lines = config.read_text(encoding="utf-8").splitlines(keepends=True)
    except OSError:
        return False

    # Either quoting style is legal for the key's own header line.
    headers = {f'[projects."{key}"]', f"[projects.'{key}']"}
    out: list[str] = []
    dropping = False
    dropped = False
    for line in lines:
        stripped = line.strip()
        if stripped in headers:
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


# ── assessment ─────────────────────────────────────────────────────────────


def assess(row: dict[str, Any], *, now: Optional[datetime] = None) -> ProjectCleanupSpec:
    """One project, with the detail the cleanup screen shows."""
    cwd = row.get("cwd") or ""
    path = Path(cwd)
    stat = _stat_or_none(path)
    verdict = classify(row, now=now, stat=stat)
    # A missing directory needs no special case: the walk yields nothing and
    # `.git` does not exist, so both answer zero on their own.
    count, size, capped = count_files(path)
    return ProjectCleanupSpec(
        project_id=str(row.get("id") or ""),
        name=str(row.get("name") or ""),
        cwd=cwd,
        verdict=verdict,
        file_count=count,
        size_bytes=size,
        file_count_capped=capped,
        dir_modified_at=_iso_from_seconds(stat.st_mtime if stat else None),
        modified_at=_iso_from_row(row.get("modified_at")),
        last_active_at=_iso_from_row(row.get("last_active_at")),
        harnesses=harness_uses(row),
        git=GitInfoSpec(has_repo=(path / ".git").exists()),
    )


def assess_all(
    rows: Iterable[dict[str, Any]], *, now: Optional[datetime] = None
) -> tuple[list[ProjectCleanupSpec], CleanupSummarySpec]:
    """The cleanup screen's payload, worst-first, plus the counts it implies.

    The summary is derived from the verdicts just computed rather than by a
    second ``summarize`` pass — classifying all 1,250 projects twice in one
    request was about a fifth of this function's cost.

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
    return specs, _count_verdicts(spec.verdict for spec in specs)


# ── removal ────────────────────────────────────────────────────────────────


class CleanupRefused(Exception):
    """A guard said no. Carries the reason the UI shows verbatim."""


def guard_deletable(cwd: str) -> Path:
    """Refuse anything that is not a deletable project directory.

    Fails closed on every unclear case: ``is_protected_path`` already protects
    filesystem roots, the user home and the workspace container itself, and the
    containment check means a bad ``cwd`` cannot reach outside the workspace
    even if a caller supplies one directly.
    """
    if not cwd:
        raise CleanupRefused("No path on this project")
    path = Path(cwd)
    if is_protected_path(path):
        raise CleanupRefused(f"{cwd} is a protected path")
    workspace = agent_workspace_root()
    try:
        resolved = canonical_posix_path(path)
        workspace_canonical = canonical_posix_path(workspace)
    except (OSError, ValueError) as exc:
        raise CleanupRefused(f"Cannot resolve {cwd}") from exc
    if resolved == workspace_canonical:
        # `is_path_under` is true for the root itself, and `is_protected_path`
        # covers only the REAL configured workspace — so name this case rather
        # than let either stand alone between a caller and the whole tree.
        raise CleanupRefused(f"{cwd} is the workspace root")
    if not is_path_under(resolved, workspace_canonical):
        raise CleanupRefused(f"{cwd} is outside {workspace}")
    return Path(resolved)


def clear_harness_state(row: dict[str, Any], index: HarnessIndex) -> dict[str, Any]:
    """Delete this project's harness state. Does not raise when there is none.

    The query and the refusal are split: this reports what it removed, and
    :func:`remove_from_harness` is the one that turns "nothing to remove" into a
    refusal. That keeps ``CleanupRefused`` meaning exactly one thing — a guard
    said no — so a delete can call this directly without a ``try`` that would
    also swallow a real guard.
    """
    cwd = row.get("cwd") or ""
    removed: list[str] = []
    for target in index.any_state(cwd):
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
    return {
        "cwd": cwd,
        "removed_paths": removed,
        "codex_config_entry_removed": drop_codex_config_entry(cwd),
    }


def has_harness_state(cwd: str, index: HarnessIndex) -> bool:
    """Whether clearing would remove anything.

    False for every empty workspace folder — a directory a harness ran in but
    never opened a session in leaves nothing behind. The codex config entry
    counts on its own: Codex prunes transcripts but keeps the registration, and
    without this such a project could never be un-registered.
    """
    return bool(index.any_state(cwd)) or codex_config_entry(cwd) is not None


def remove_from_harness(row: dict[str, Any], index: HarnessIndex) -> dict[str, Any]:
    """Clear harness state, refusing when there is none to clear.

    Refused rather than reported as a success that did nothing, which would tell
    the user their harness history is gone when it never existed.
    """
    cwd = row.get("cwd") or ""
    if not has_harness_state(cwd, index):
        raise CleanupRefused("No harness state for this project")
    return clear_harness_state(row, index)


__all__ = [
    "CleanupRefused",
    "HarnessIndex",
    "assess",
    "assess_all",
    "classify",
    "clear_harness_state",
    "codex_config_entry",
    "count_files",
    "drop_codex_config_entry",
    "git_detail",
    "guard_deletable",
    "harness_uses",
    "has_harness_state",
    "has_visible_entry",
    "remove_from_harness",
    "summarize",
]
