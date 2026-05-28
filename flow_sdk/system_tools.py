"""System-level tools for data management.

Reusable business logic for: clear index, backup, clear all data, archive, restore.
The desktop_db action and any other caller should import from here — not duplicate logic.
"""

from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from pydantic import BaseModel

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Result models
# ---------------------------------------------------------------------------


class BackupResult(BaseModel):
    backup_path: str
    message: str


class ClearIndexResult(BaseModel):
    fts_cleared: int
    entities_cleared: int


class ClearAllResult(BaseModel):
    backup_path: str
    message: str


class ArchiveResult(BaseModel):
    archive_path: str
    message: str


class RestoreResult(BaseModel):
    message: str


class DatabasePathsResult(BaseModel):
    db_path: str
    backup_folder: str
    db_folder: str
    logs_folder: str


class EntityTypeCount(BaseModel):
    type: str
    count: int


class DatabaseStatsResult(BaseModel):
    file_size_bytes: int
    total_entities: int
    total_relationships: int
    entity_types: list[EntityTypeCount]


class DbSettingsResult(BaseModel):
    db_path: str
    default_path: str


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _default_db_path() -> str:
    from flow_sdk.instance_settings import get_instance_settings
    return str(get_instance_settings().db_path)


def get_db_path() -> Path:
    """Per-instance SQLite database path (call-time, via InstanceSettings).

    InstanceSettings reads the SQLITE_DATABASE_PATH env var inside `from_env()`;
    we never read the env here directly.
    """
    from flow_sdk.instance_settings import get_instance_settings
    settings = get_instance_settings()
    settings.db_dir.mkdir(parents=True, exist_ok=True)
    return Path(settings.db_path)


def get_backup_folder() -> Path:
    """Per-instance backup directory.

    Backups live under ``<instance_dir>/backups`` (not the legacy shared
    ``~/.flowpad/backups``). Two instances on the same machine (e.g.
    ``app`` and ``oss``) used to collide on identical timestamps + filenames
    in the shared folder; moving under ``instance_dir`` keeps them isolated.
    """
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    folder = get_instance_settings().instance_dir / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def get_db_folder() -> Path:
    return get_db_path().parent


def get_logs_folder() -> Path:
    """Per-instance logs directory (call-time, via InstanceSettings).

    Resolves to ``<flow_home>/instances/<instance_name>/logs`` so the dev
    (port 9008) and prod (port 9007) backends keep their logs in separate
    folders. This is what the ``open-logs`` action opens and what the UI
    shows as the log folder path.
    """
    from flow_sdk.instance_settings import get_instance_settings
    folder = get_instance_settings().logs_dir
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def get_database_paths() -> DatabasePathsResult:
    return DatabasePathsResult(
        db_path=str(get_db_path()),
        backup_folder=str(get_backup_folder()),
        db_folder=str(get_db_folder()),
        logs_folder=str(get_logs_folder()),
    )


# ---------------------------------------------------------------------------
# Index
# ---------------------------------------------------------------------------


async def clear_index(types: list[str] | None = None) -> ClearIndexResult:
    """Clear FTS index + record-backed entities. Optionally scoped to specific types.

    ``SchemaRegistry.clear_index`` is the authoritative implementation and is
    careful to delete only schema-registered record types (not arbitrary
    anonymous entities like user-created projects/workspaces).
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    result = await SchemaRegistry.clear_index(types)
    return ClearIndexResult(
        fts_cleared=result.fts_cleared,
        entities_cleared=result.entities_cleared,
    )


# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------


async def backup_db() -> BackupResult:
    """Backup the SQLite database to the backups folder."""
    db_path = get_db_path()
    if not db_path.exists():
        raise FileNotFoundError("Database file does not exist")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = get_backup_folder() / f"flowpad_db_{timestamp}"
    shutil.copy2(db_path, backup_path)
    logger.info(f"Database backed up to: {backup_path}")

    return BackupResult(
        backup_path=str(backup_path),
        message="Database backed up successfully",
    )


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _scan_backup_folder(folder: Path) -> list[Path]:
    """Collect candidate backup files from a single folder."""
    candidates: list[Path] = []
    if not folder.exists():
        return candidates
    for entry in folder.iterdir():
        if entry.is_file() and entry.name.startswith("flowpad_db_"):
            candidates.append(entry)
        elif entry.is_dir() and entry.name.startswith("archive_"):
            db_inside = entry / "flowpad_db"
            if db_inside.exists():
                candidates.append(db_inside)
    return candidates


def find_last_valid_db_backup() -> Path | None:
    """Return the path of the most recent valid DB file from the backups folder.

    Scans two backup layouts (newest first):
      - flowpad_db_YYYYMMDD_HHMMSS        (plain backup files)
      - archive_YYYYMMDD_HHMMSS/flowpad_db (archive folders)

    Looks first in the per-instance folder (``<instance_dir>/backups``).
    If nothing valid is found, falls back to the legacy shared folder
    (``~/.flowpad/backups``) so installations that upgraded from a layout
    where backups lived in the shared location can still recover. Without
    the fallback, ``ensure_db`` would silently reinitialise a fresh DB on
    first post-upgrade boot and lose recoverable user history.

    Returns None if no valid backup is found in either folder.
    """
    backup_folder = get_backup_folder()
    legacy_folder = Path.home() / ".flowpad" / "backups"

    folders: list[Path] = [backup_folder]
    if legacy_folder != backup_folder and legacy_folder.exists():
        folders.append(legacy_folder)

    candidates: list[Path] = []
    for folder in folders:
        candidates.extend(_scan_backup_folder(folder))

    # Sort newest-first by the timestamp embedded in the parent name
    candidates.sort(key=lambda p: p.parent.name if p.name == "flowpad_db" else p.name, reverse=True)

    for candidate in candidates:
        if validate_db(candidate):
            logger.info(f"find_last_valid_db_backup: found valid backup at {candidate}")
            return candidate

    logger.warning("find_last_valid_db_backup: no valid backup found")
    return None


def ensure_db() -> bool:
    """Validate the current DB and recover if corrupted.

    Recovery order:
      1. Restore from the latest valid backup (if one exists).
      2. If no backup, delete the malformed file so the server initialises a fresh DB,
         and write a RecordError so the incident is visible in the UI.

    Synchronous — safe to call before the server initialises the DB layer.
    Returns True if the DB is healthy or was recovered, False only if reinitialising fresh.
    """
    db_path = get_db_path()
    if validate_db(db_path):
        return True

    logger.warning(f"ensure_db: DB is corrupted at {db_path}, attempting recovery...")

    backup = find_last_valid_db_backup()
    if backup is not None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(backup, db_path)
        logger.info(f"ensure_db: restored from {backup}")
        return True

    # No valid backup — delete so the server starts fresh
    logger.error("ensure_db: no valid backup found — reinitialising fresh DB")
    try:
        db_path.unlink(missing_ok=True)
    except OSError as e:
        logger.error(f"ensure_db: failed to remove malformed DB: {e}")

    _write_db_corruption_error(db_path)
    return False


def _write_db_corruption_error(db_path: Path) -> None:
    """Write a RecordError recording the DB corruption incident."""
    from datetime import datetime, timezone  # noqa: PLC0415

    from flow_sdk.fs_records.record_error import RecordError  # noqa: PLC0415

    try:
        rec = RecordError(
            trigger="ensure_db",
            error_type="DatabaseCorruption",
            error_message=(
                f"Database at {db_path} was malformed and no valid backup was found. "
                "The database has been reinitialised fresh — all previous data is lost."
            ),
            occurred_at=datetime.now(timezone.utc).isoformat(),
        )
        rec.save()
        logger.info("ensure_db: corruption RecordError written")
    except Exception as e:
        logger.error(f"ensure_db: failed to write RecordError: {e}")


def validate_db(db_path: Path | None = None) -> bool:
    """Check whether the SQLite DB file is intact.

    Completely independent — uses only stdlib sqlite3, no SDK imports.
    Returns True if the database is healthy, False if it is corrupted or missing.
    """
    import sqlite3 as stdlib_sqlite3  # noqa: PLC0415

    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415

    path = db_path or get_db_path()
    if not path.exists():
        logger.warning(f"validate_db: file not found at {path}")
        return False

    try:
        conn = open_sqlite(path)
        try:
            rows = conn.execute("PRAGMA integrity_check").fetchall()
            # SQLite returns [('ok',)] when healthy; any other rows mean corruption.
            ok = len(rows) == 1 and rows[0][0] == "ok"
            if not ok:
                issues = [r[0] for r in rows]
                logger.warning(f"validate_db: integrity_check failed — {issues}")
            return ok
        finally:
            conn.close()
    except stdlib_sqlite3.DatabaseError as exc:
        logger.warning(f"validate_db: could not open database — {exc}")
        return False


# ---------------------------------------------------------------------------
# Clear all data (DB + index)
# ---------------------------------------------------------------------------


async def clear_all_data() -> ClearAllResult:
    """Backup, wipe the SQLite DB, clear the index, reinitialize.

    This is the canonical "factory reset" — clears both the entity DB and
    all scan/index data so the state is fully consistent afterward.
    """
    db_path = get_db_path()
    if not db_path.exists():
        raise FileNotFoundError("Database file does not exist")

    # 1. Backup first
    backup = await backup_db()

    # 2. Clear the scan index (FTS + index logs + RecordErrors)
    await clear_index()

    # 3. Drop in-memory caches
    from flow_sdk.core.cache.entity_cache import entity_cache, uname_cache  # noqa: PLC0415

    entity_cache.clear()
    uname_cache.clear()

    # 4. Close DB, delete file, reinitialize
    from flow_sdk.db.database import close_db, init_db  # noqa: PLC0415
    from flow_sdk.db.drivers.db_driver import _driver_instances, get_db_driver, LazyDBDriver  # noqa: PLC0415
    from flow_sdk.db.db_entity import DBEntity  # noqa: PLC0415
    from flow_sdk.db.db_relationship import DBRelationship  # noqa: PLC0415

    # Close the SQLiteDriver's own engine before wiping the file
    sqlite_driver = _driver_instances.get("sqlite")
    if sqlite_driver is not None:
        await sqlite_driver.close()

    await close_db()
    db_path.unlink()
    logger.info(f"Database file deleted: {db_path}")
    await init_db()

    # DBEntity._db / DBRelationship._db are LazyDBDriver descriptors that
    # snapshot the active driver on first access. After ``init_db`` builds
    # a fresh driver, point both class-level caches at it so reads/writes
    # go through the new instance — otherwise we read from a closed driver
    # whose connections were torn down above (silent split-brain).
    new_driver = get_db_driver()
    DBEntity._db = new_driver
    DBRelationship._db = new_driver

    # Invalidate the bootstrap cache and immediately rebuild the @local
    # entities. Without the rebuild, subsequent requests addressed via
    # `/compute_node/@local/...` cannot resolve `@local` (it has just been
    # wiped) and the request middleware returns "Invalid request" until the
    # client happens to call /bootstrap again.
    from flow_sdk.server.routes.bootstrap import (  # noqa: PLC0415
        bootstrap,
        invalidate_bootstrap_cache,
    )
    invalidate_bootstrap_cache()
    await bootstrap()

    return ClearAllResult(
        backup_path=backup.backup_path,
        message="All data has been cleared. A backup was created.",
    )


# ---------------------------------------------------------------------------
# Archive
# ---------------------------------------------------------------------------


async def archive() -> ArchiveResult:
    """Create a full archive: DB backup + records snapshot in a timestamped folder."""
    from flow_sdk.fs_store.record import get_default_records_root  # noqa: PLC0415

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    archive_dir = get_backup_folder() / f"archive_{timestamp}"
    archive_dir.mkdir(parents=True, exist_ok=True)

    # Copy DB
    db_path = get_db_path()
    if db_path.exists():
        shutil.copy2(db_path, archive_dir / "flowpad_db")

    # Copy records root
    records_root = get_default_records_root()
    if records_root.exists():
        shutil.copytree(records_root, archive_dir / "records", dirs_exist_ok=True, ignore_dangling_symlinks=True)

    logger.info(f"Archive created at: {archive_dir}")
    return ArchiveResult(
        archive_path=str(archive_dir),
        message=f"Archive created at {archive_dir}",
    )


# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------


async def restore(backup_path: str) -> RestoreResult:
    """Restore the SQLite DB from a backup file.

    Clears the index after restore so it reflects the restored DB state.
    """
    src = Path(backup_path)
    if not src.exists():
        raise FileNotFoundError(f"Backup not found: {backup_path}")

    db_path = get_db_path()

    from flow_sdk.core.cache.entity_cache import entity_cache, uname_cache  # noqa: PLC0415
    from flow_sdk.db.database import close_db, init_db  # noqa: PLC0415

    await close_db()
    shutil.copy2(src, db_path)
    logger.info(f"Database restored from: {src}")

    entity_cache.clear()
    uname_cache.clear()

    await init_db()

    # Clear index — it no longer reflects the restored DB
    await clear_index()

    return RestoreResult(message=f"Database restored from {src.name}. Index cleared.")


# ---------------------------------------------------------------------------
# Stats / settings
# ---------------------------------------------------------------------------


async def get_database_stats() -> DatabaseStatsResult:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415

    db_path = get_db_path()
    if not db_path.exists():
        raise FileNotFoundError("Database file does not exist")

    file_size = db_path.stat().st_size
    conn = open_sqlite(db_path)
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM entities")
        total_entities = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM relationships")
        total_relationships = cur.fetchone()[0]
        cur.execute("SELECT type, COUNT(*) as cnt FROM entities GROUP BY type ORDER BY cnt DESC")
        entity_types = [EntityTypeCount(type=row[0], count=row[1]) for row in cur.fetchall()]
    finally:
        conn.close()

    return DatabaseStatsResult(
        file_size_bytes=file_size,
        total_entities=total_entities,
        total_relationships=total_relationships,
        entity_types=entity_types,
    )


def get_db_settings() -> DbSettingsResult:
    return DbSettingsResult(
        db_path=str(get_db_path()),
        default_path=_default_db_path(),
    )


async def set_db_path(new_path: str) -> DbSettingsResult:
    """Switch the active database to a new path and reinitialize."""
    expanded = os.path.expanduser(new_path.strip())
    parent = Path(expanded).parent
    if not parent.exists():
        raise ValueError(f"Directory does not exist: {parent}")
    if not os.access(parent, os.W_OK):
        raise ValueError(f"Directory is not writable: {parent}")

    from flow_sdk.db.database import reinit_db  # noqa: PLC0415

    await reinit_db(expanded)
    logger.info(f"Database switched to: {expanded}")
    return DbSettingsResult(db_path=expanded, default_path=_default_db_path())


# ---------------------------------------------------------------------------
# Scan info
# ---------------------------------------------------------------------------


async def get_scan_info() -> dict:
    """Return current index status. Reads JSONL bookkeeping + queries the DB
    for live entity counts (single chokepoint via SchemaRegistry.get_index_status)."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    status = await SchemaRegistry.get_index_status()
    total_indexed = sum(t.entity_count for t in status.per_type)
    return {
        "total_indexed": total_indexed,
        "last_indexed_at": status.last_indexed_at,
        "never_indexed": status.never_indexed,
        "stale": status.stale,
    }


# ---------------------------------------------------------------------------
# OS folder opener
# ---------------------------------------------------------------------------


def open_folder(folder_path: Path) -> None:
    folder_str = str(folder_path.resolve())
    system = platform.system()
    try:
        if system == "Windows":
            subprocess.run(["explorer", folder_str], check=False, timeout=5)
        elif system == "Darwin":
            subprocess.run(["open", folder_str], check=True, timeout=5)
        else:
            subprocess.run(["xdg-open", folder_str], check=True, timeout=5)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError) as e:
        logger.error(f"Failed to open folder {folder_str}: {e}")
        raise
