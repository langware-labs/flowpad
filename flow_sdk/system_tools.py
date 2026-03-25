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

DEFAULT_DB_PATH = str(Path.home() / ".flow" / "db" / "flowpad_db")


def get_db_path() -> Path:
    db_path_str = os.environ.get("SQLITE_DATABASE_PATH")
    if not db_path_str:
        db_folder = Path.home() / ".flow" / "db"
        db_folder.mkdir(parents=True, exist_ok=True)
        db_path_str = str(db_folder / "flowpad_db")
    return Path(db_path_str)


def get_backup_folder() -> Path:
    folder = Path.home() / ".flowpad" / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def get_db_folder() -> Path:
    return get_db_path().parent


def get_logs_folder() -> Path:
    folder = Path.home() / "Flowpad workspace" / ".flow" / "logs"
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
    """Clear FTS index + indexed entity records. Optionally scoped to specific types."""
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
    from flow_sdk.db.drivers.db_driver import _driver_instances  # noqa: PLC0415

    # Close the SQLiteDriver's own engine before wiping the file
    sqlite_driver = _driver_instances.get("sqlite")
    if sqlite_driver is not None:
        await sqlite_driver.close()

    await close_db()
    db_path.unlink()
    logger.info(f"Database file deleted: {db_path}")
    await init_db()

    # Reopen the SQLiteDriver so it points to the new DB file
    if sqlite_driver is not None:
        await sqlite_driver.open()

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
        shutil.copytree(records_root, archive_dir / "records", dirs_exist_ok=True)

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
    import sqlite3 as stdlib_sqlite3  # noqa: PLC0415

    db_path = get_db_path()
    if not db_path.exists():
        raise FileNotFoundError("Database file does not exist")

    file_size = db_path.stat().st_size
    conn = stdlib_sqlite3.connect(str(db_path))
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
        default_path=DEFAULT_DB_PATH,
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
    return DbSettingsResult(db_path=expanded, default_path=DEFAULT_DB_PATH)


# ---------------------------------------------------------------------------
# Scan info
# ---------------------------------------------------------------------------


def get_scan_info() -> dict:
    """Return current index status — reads SchemaRegistry in-memory log cache, no DB query."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    status = SchemaRegistry.get_index_status()
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
