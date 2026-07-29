"""Move flowpad-native assets out of the harness dot-dirs into ``agentic-assets/``.

Flowpad used to write its own assets into ``.claude/<something>`` — whiteboards,
journeys, agentic-flows, agent traces, usage/cleanup reports, received
transcripts. None of those directories are part of any harness's vocabulary
(Claude Code reads ``skills``, ``agents``, ``commands``, ``rules``, ``workflows``,
``output-styles``, ``themes``, ``plugins``, ``projects``, ``memory``), so those
types were reclassified to ``AssetClass.REPO`` and now mount at
``<root>/agentic-assets/<type>/``.

The walkers for the old locations were deleted with the reclassification, so
without this script the existing folders would simply stop being indexed — the
assets would still be on disk but invisible in the app.

Contract:
* MOVE semantics, per asset — a legacy child is moved only when its destination
  does not already exist. Collisions are left in place and reported, never
  overwritten.
* Idempotent — once a legacy directory is gone (or empty) every later run is a
  no-op. Safe to re-run after a partial/interrupted run.
* ``~/.claude/plans`` is NEVER touched. That directory belongs to Claude Code
  (plan-mode output) and flowpad still reads it via ``claude_plan_fn``; only
  PROJECT-scope ``.claude/plans`` was flowpad's own.

Entry point: ``run()``. The runner calls it with no args.
"""

from __future__ import annotations

import json
import logging
import shutil
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from flow_sdk.fs_store.placement import AGENTIC_ASSETS_DIR

logger = logging.getLogger(__name__)

# (legacy scope-relative dir, destination type name, project_scope_only).
#
# The destination is always ``agentic-assets/<type name>`` — repo families are
# named after their type. ``project_scope_only`` marks a legacy path that is a
# real harness directory at user scope and must be left alone there.
LEGACY_FAMILIES: list[tuple[str, str, bool]] = [
    # Reclassified out of the harness dot-dirs.
    (".claude/whiteboards", "whiteboard", False),
    (".claude/journeys", "journey", False),
    (".claude/agentic-flows", "agentic_flow", False),
    (".claude/agent_traces", "agent_trace", False),
    (".claude/usage_reports", "usage_report", False),
    (".claude/cleanup_reports", "asset_cleanup_report", False),
    # ``~/.claude/plans`` is Claude Code's own plan-mode output — project scope only.
    (".claude/plans", "plan", True),
    # Installed (received) transcripts. The harnesses' OWN session stores
    # (~/.claude/projects, ~/.codex/sessions, ~/.copilot/session-state) are
    # untouched — they are read in place by the per-worker walkers.
    (".claude/transcripts", "claude_session", False),
    (".agents/transcripts", "codex_session", False),
    (".github/transcripts", "copilot_session", False),
    # Reclassified out of the bare project root.
    ("prompts", "prompt", False),
    ("assets/spreadsheets", "spreadsheet", False),
    # The earlier repo-asset cut shipped without a mover, so these legacy
    # locations may still be sitting un-indexed in older projects.
    ("tasks", "task", False),
    ("specs", "spec", False),
    ("assets/datasets", "dataset", False),
    ("assets/decks", "deck", False),
    ("assets/deck-templates", "deck_template", False),
]


@dataclass
class RootReport:
    """What happened under one scope root."""

    root: Path
    scope: str
    moved: list[tuple[str, str]] = field(default_factory=list)
    collisions: list[str] = field(default_factory=list)

    @property
    def touched(self) -> bool:
        return bool(self.moved or self.collisions)


def _project_mounts() -> list[Path]:
    """Every project's on-disk mount, read straight from sqlite.

    ``fs_storage_mount_path`` lives inside the JSON ``data`` column, so the rows
    are loaded and unpacked in Python — the sync mirror of ``Project.get_all()``
    (see ``_lookup_project_id_by_cwd`` in ``fs_store/indexer/roots.py``, same
    shape). The migration runner calls ``run()`` from inside an event loop, so an
    async query is not available here.

    Mounts are filtered through ``is_valid_project_cwd`` — the same policy gate
    the async ``load_project_mounts()`` applies — so this never rewrites files
    under a protected or temp path that the indexer itself would refuse to walk.
    """
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite
    from flow_sdk.fs_store.path_utils import is_valid_project_cwd
    from flow_sdk.instance_settings import get_instance_settings

    db_path = get_instance_settings().db_path
    if not db_path or not Path(db_path).exists():
        return []
    try:
        conn = open_sqlite(db_path)
    except sqlite3.Error:
        return []
    out: list[Path] = []
    try:
        for row in conn.execute("SELECT data FROM entities WHERE type='project'").fetchall():
            if not row[0]:
                continue
            try:
                data = json.loads(row[0])
            except (json.JSONDecodeError, TypeError):
                continue
            mount = data.get("fs_storage_mount_path") or data.get("cwd")
            if mount and is_valid_project_cwd(mount) and Path(mount).is_dir():
                out.append(Path(mount))
    except sqlite3.Error:
        return out
    finally:
        conn.close()
    return out


def _migrate_family(root: Path, legacy_rel: str, type_name: str, report: RootReport) -> None:
    """Move every child of ``<root>/<legacy_rel>`` into ``agentic-assets/<type>``."""
    legacy = root / legacy_rel
    if not legacy.is_dir():
        return
    dest = root / AGENTIC_ASSETS_DIR / type_name

    children = sorted(legacy.iterdir())
    for child in children:
        target = dest / child.name
        if target.exists():
            # Never overwrite: the new location already has an asset by this
            # name, so the legacy copy is stale or a genuine conflict. Leave it
            # on disk for the user to resolve.
            report.collisions.append(f"{legacy_rel}/{child.name}")
            continue
        dest.mkdir(parents=True, exist_ok=True)
        shutil.move(str(child), str(target))
        report.moved.append((f"{legacy_rel}/{child.name}", f"{AGENTIC_ASSETS_DIR}/{type_name}/{child.name}"))

    # Drop the legacy directory once it is empty, so the next run is a clean
    # no-op and the dot-dir stops advertising a family the harness never had.
    try:
        if not any(legacy.iterdir()):
            legacy.rmdir()
    except OSError:
        pass


def _migrate_root(root: Path, scope: str) -> RootReport:
    report = RootReport(root=root, scope=scope)
    for legacy_rel, type_name, project_only in LEGACY_FAMILIES:
        if project_only and scope != "project":
            continue
        try:
            _migrate_family(root, legacy_rel, type_name, report)
        except OSError as e:
            logger.warning("migrate 0.2.112: %s under %s failed: %s", legacy_rel, root, e)
    return report


def run() -> list[RootReport]:
    """Migrate every scope root. Returns one report per root that changed."""
    from flow_sdk.instance_settings import get_instance_settings

    roots: list[tuple[Path, str]] = []
    user_home = get_instance_settings().user_home
    if user_home and Path(user_home).is_dir():
        roots.append((Path(user_home), "user"))
    roots.extend((mount, "project") for mount in _project_mounts())

    reports = [_migrate_root(root, scope) for root, scope in roots]
    touched = [r for r in reports if r.touched]

    total = sum(len(r.moved) for r in touched)
    if not total and not any(r.collisions for r in touched):
        print("agentic-assets migration: nothing to move.")
        return touched

    print(f"agentic-assets migration: moved {total} asset(s) across {len(touched)} root(s).")
    for r in touched:
        print(f"  {r.scope}: {r.root}")
        for src, dst in r.moved:
            print(f"    {src} -> {dst}")
        for c in r.collisions:
            print(f"    SKIPPED (destination exists): {c}")
    return touched
