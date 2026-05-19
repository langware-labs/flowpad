"""Consolidate scattered per-instance state under ~/.flow/instances/<name>/.

Preparation script for the InstanceSettings refactor (plan:
i-would-like-the-whimsical-wilkinson). Runs at boot via the migrations runner.

Contract:
* COPY semantics — legacy files are never moved or deleted. Rollback is
  ``rm -rf <flow_home>/instances/``.
* Idempotent — skip per-instance work if ``<instance_dir>/.migrated`` exists.
* Self-contained — no flow_sdk imports; safe to run before Phase A-D code lands.
* Credentials/sodot are NOT bootstrapped here. That step is gated on the
  ``.secrets_enabled`` consent marker (Phase C) and lives in a separate step.

Entry point: ``run()``. The runner calls it with no args; everything is
resolved from ``FLOW_HOME`` (default ``~/.flow``).
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)


# (instance_name, legacy_prefix). Order matters only for output readability.
LEGACY_INSTANCES: list[tuple[str, str]] = [
    ("prod", ""),
    ("dev", "dev_"),
    ("test", "test_"),
]

# (legacy_basename_template, new_basename). Template uses ``{p}`` for prefix.
FILE_COPIES: list[tuple[str, str]] = [
    ("{p}server.json", "server.json"),
    ("{p}server.pid", "server.pid"),
    ("{p}server.lock", "server.lock"),
    (".{p}inbox_last_fetch.json", "inbox.json"),
    (".{p}conversation_last_sync.json", "conversation_sync.json"),
]

DIR_COPIES: list[tuple[str, str]] = [
    ("{p}records", "records"),
    ("{p}records_data", "records_data"),
    ("{p}logs", "logs"),
    ("{p}tasks", "tasks"),
    ("{p}skill_rules", "skill_rules"),
    ("{p}schema", "schema"),
]

# Sqlite db lives at {prefix}db/flowpad_db with -shm/-wal sidecars.
# Flatten to <instance_dir>/flowpad.db (+ sidecars).
DB_SOURCE_SUBDIR = "{p}db"
DB_SOURCE_BASENAME = "flowpad_db"
DB_DEST_BASENAME = "flowpad.db"
DB_SIDECAR_SUFFIXES = ("-shm", "-wal")

# Top-level items under flow_home with zero remaining code references. Verified
# by grep across flow_sdk/ — see plan section "Bonus finding — dead InstanceSettings
# properties" for the audit notes. Files are deleted; dirs are rmtree'd. Anything
# not in this list is left strictly alone.
#
# DO NOT add entries casually — every item here was confirmed dead. Adding a
# false positive deletes user data.
JUNK_FILES: list[str] = [
    ".DS_Store",
    "flow.db",            # 0 bytes, no refs
    "flowpad.db",         # 0 bytes top-level; also conflicts with new <instance_dir>/flowpad.db
    "records.db",         # 0 bytes, no refs
    "minihub.db",         # legacy minihub artifact; only test refs, all marked skip
    "monitor.log",        # top-level stale; launch.py writes to logs/monitor/<timestamp>.log
    "server.log",         # top-level stale; launch.py writes to logs/server/<timestamp>.log
    "db/entities.db",     # no code refs (db/ only used for flowpad_db)
]
JUNK_DIRS: list[str] = [
    "sessions",   # all "sessions" code refs point at ~/.codex/sessions/, not ~/.flow/sessions/
    "index",      # only schema/index_log.jsonl is used (covered by schema/ migration)
    "skillit",    # skillit_records plugin uses its own path, not ~/.flow/skillit/
    "storage",    # zero matches in codebase
]


@dataclass
class CleanupReport:
    """What junk-cleanup did (or would do)."""

    deleted_files: list[Path] = field(default_factory=list)
    deleted_dirs: list[Path] = field(default_factory=list)
    not_present: list[Path] = field(default_factory=list)
    failed: list[tuple[Path, str]] = field(default_factory=list)  # (path, reason)


@dataclass
class InstanceReport:
    """What happened (or would happen) for one legacy instance."""

    instance_name: str
    prefix: str
    instance_dir: Path
    detected: bool = False  # any legacy artifact found for this prefix?
    skipped_already_done: bool = False
    files_copied: list[tuple[Path, Path]] = field(default_factory=list)
    dirs_copied: list[tuple[Path, Path]] = field(default_factory=list)
    db_copied: list[tuple[Path, Path]] = field(default_factory=list)
    missing_sources: list[Path] = field(default_factory=list)
    skipped_dst_exists: list[Path] = field(default_factory=list)


def _resolve_flow_home() -> Path:
    return Path(os.environ.get("FLOW_HOME") or (Path.home() / ".flow"))


def _detect_legacy(flow_home: Path, prefix: str) -> bool:
    """True if any plan-enumerated legacy artifact exists for this prefix.

    Used to skip empty prefixes entirely (no point creating ``instances/test/``
    if no test_* state has ever existed on this machine).
    """
    probes = [
        flow_home / f"{prefix}server.json",
        flow_home / f"{prefix}db",
        flow_home / f"{prefix}records",
        flow_home / f"{prefix}logs",
        flow_home / f"{prefix}tasks",
    ]
    return any(p.exists() for p in probes)


def _copy_file(src: Path, dst: Path, report: InstanceReport, *, dry_run: bool) -> None:
    if not src.exists():
        report.missing_sources.append(src)
        return
    if dst.exists():
        report.skipped_dst_exists.append(dst)
        return
    if not dry_run:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    report.files_copied.append((src, dst))


def _copy_dir(src: Path, dst: Path, report: InstanceReport, *, dry_run: bool) -> None:
    if not src.exists():
        report.missing_sources.append(src)
        return
    if dst.exists():
        report.skipped_dst_exists.append(dst)
        return
    if not dry_run:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dst)
    report.dirs_copied.append((src, dst))


def _copy_db(flow_home: Path, prefix: str, dst_dir: Path,
             report: InstanceReport, *, dry_run: bool) -> None:
    """Flatten ``{prefix}db/flowpad_db`` (+ -shm/-wal) → ``<instance_dir>/flowpad.db``."""
    src_subdir = flow_home / DB_SOURCE_SUBDIR.format(p=prefix)
    src_db = src_subdir / DB_SOURCE_BASENAME
    if not src_db.exists():
        report.missing_sources.append(src_db)
        return
    dst_db = dst_dir / DB_DEST_BASENAME
    if dst_db.exists():
        report.skipped_dst_exists.append(dst_db)
    else:
        if not dry_run:
            dst_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_db, dst_db)
        report.db_copied.append((src_db, dst_db))
    # WAL/SHM sidecars — copy with matching name change so sqlite finds them.
    for suffix in DB_SIDECAR_SUFFIXES:
        src_side = src_subdir / f"{DB_SOURCE_BASENAME}{suffix}"
        dst_side = dst_dir / f"{DB_DEST_BASENAME}{suffix}"
        if not src_side.exists():
            continue
        if dst_side.exists():
            report.skipped_dst_exists.append(dst_side)
            continue
        if not dry_run:
            shutil.copy2(src_side, dst_side)
        report.db_copied.append((src_side, dst_side))


def migrate_instance_folder(
    instance_name: str,
    legacy_prefix: str,
    flow_home: Path,
    *,
    dry_run: bool = False,
) -> InstanceReport:
    """Copy one legacy instance's state into the new layout. Idempotent."""
    instance_dir = flow_home / "instances" / instance_name
    report = InstanceReport(
        instance_name=instance_name, prefix=legacy_prefix, instance_dir=instance_dir,
    )

    if not _detect_legacy(flow_home, legacy_prefix):
        return report  # no legacy state for this prefix; nothing to do
    report.detected = True

    # Idempotency marker. We use a dedicated marker file (not "sodot exists",
    # which the original plan suggested) because Phase E ships before
    # Phase C — there is no sodot yet, and we want the migration to be a
    # no-op on second boot even if no credentials have been migrated.
    marker = instance_dir / ".migrated"
    if marker.exists():
        report.skipped_already_done = True
        return report

    if not dry_run:
        instance_dir.mkdir(parents=True, exist_ok=True)

    for src_tmpl, dst_name in FILE_COPIES:
        _copy_file(
            flow_home / src_tmpl.format(p=legacy_prefix),
            instance_dir / dst_name,
            report, dry_run=dry_run,
        )

    for src_tmpl, dst_name in DIR_COPIES:
        _copy_dir(
            flow_home / src_tmpl.format(p=legacy_prefix),
            instance_dir / dst_name,
            report, dry_run=dry_run,
        )

    _copy_db(flow_home, legacy_prefix, instance_dir, report, dry_run=dry_run)

    if not dry_run:
        marker.touch()

    return report


def cleanup_junk(flow_home: Path, *, dry_run: bool = False) -> CleanupReport:
    """Delete the hardcoded set of verified-dead top-level items.

    Idempotent: items not present are reported but cause no error. Per-item
    exceptions are captured and reported rather than propagated, so a single
    bad permission doesn't block the rest of the cleanup.

    The script only touches paths under ``flow_home`` and only those in
    JUNK_FILES / JUNK_DIRS — no globbing, no recursion outside listed dirs.
    """
    report = CleanupReport()

    for rel in JUNK_FILES:
        target = flow_home / rel
        if not target.exists():
            report.not_present.append(target)
            continue
        try:
            if not dry_run:
                target.unlink()
            report.deleted_files.append(target)
        except OSError as exc:
            report.failed.append((target, str(exc)))

    for rel in JUNK_DIRS:
        target = flow_home / rel
        if not target.exists():
            report.not_present.append(target)
            continue
        try:
            if not dry_run:
                shutil.rmtree(target)
            report.deleted_dirs.append(target)
        except OSError as exc:
            report.failed.append((target, str(exc)))

    return report


def _format_cleanup_report(report: CleanupReport, *, dry_run: bool) -> str:
    verb = "would delete" if dry_run else "deleted"
    lines = ["\n=== junk cleanup ==="]
    if not report.deleted_files and not report.deleted_dirs:
        lines.append("  nothing to clean up")
    else:
        for p in report.deleted_files:
            lines.append(f"  {verb} file:  {p}")
        for p in report.deleted_dirs:
            lines.append(f"  {verb} dir:   {p}/")
    if report.failed:
        lines.append(f"  FAILED ({len(report.failed)}):")
        for p, reason in report.failed:
            lines.append(f"    - {p}: {reason}")
    return "\n".join(lines)


def _format_report(report: InstanceReport) -> str:
    lines = [f"\n=== instance: {report.instance_name!r} (legacy prefix: {report.prefix!r}) ==="]
    lines.append(f"  instance_dir: {report.instance_dir}")
    if not report.detected:
        lines.append("  no legacy state detected — skipped")
        return "\n".join(lines)
    if report.skipped_already_done:
        lines.append("  already migrated (.migrated marker present) — skipped")
        return "\n".join(lines)
    copied = len(report.files_copied) + len(report.dirs_copied) + len(report.db_copied)
    lines.append(f"  copied: {copied} item(s)")
    for src, dst in report.files_copied:
        lines.append(f"    file:  {src.name:40s} → {dst.relative_to(report.instance_dir)}")
    for src, dst in report.dirs_copied:
        lines.append(f"    dir:   {src.name:40s} → {dst.relative_to(report.instance_dir)}/")
    for src, dst in report.db_copied:
        lines.append(f"    db:    {src.name:40s} → {dst.relative_to(report.instance_dir)}")
    if report.skipped_dst_exists:
        lines.append(f"  skipped (dst already exists): {len(report.skipped_dst_exists)}")
        for dst in report.skipped_dst_exists:
            lines.append(f"    - {dst}")
    if report.missing_sources:
        lines.append(f"  not present in legacy layout: {len(report.missing_sources)}")
        # Don't list these — they're expected (e.g. no .test_ files on a dev machine).
    return "\n".join(lines)


def run(*, dry_run: bool = False, flow_home: Path | None = None) -> list[InstanceReport]:
    """Migrations runner entry point.

    Args:
        dry_run: when True, report what would happen without touching disk.
        flow_home: override for testing; defaults to ``$FLOW_HOME`` or ``~/.flow``.
    """
    home = flow_home or _resolve_flow_home()
    if not home.exists():
        print(f"flow_home {home} does not exist — nothing to migrate")
        return []

    reports = [
        migrate_instance_folder(name, prefix, home, dry_run=dry_run)
        for name, prefix in LEGACY_INSTANCES
    ]

    # Junk cleanup runs unconditionally after per-instance migration. It only
    # touches paths in JUNK_FILES/JUNK_DIRS — independent of migration success,
    # safe to run even if some instance copies failed.
    cleanup = cleanup_junk(home, dry_run=dry_run)

    header = "DRY RUN — no files written" if dry_run else "migration complete"
    print(f"\n{'=' * 60}\n{header}\nflow_home: {home}\n{'=' * 60}")
    for report in reports:
        print(_format_report(report))
    print(_format_cleanup_report(cleanup, dry_run=dry_run))
    print()
    return reports


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    home_arg = None
    for arg in sys.argv[1:]:
        if arg.startswith("--flow-home="):
            home_arg = Path(arg.split("=", 1)[1])
    run(dry_run=dry, flow_home=home_arg)
