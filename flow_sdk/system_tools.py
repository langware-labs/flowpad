"""System-level tools for data management.

Reusable business logic for: clear index, backup, clear all data, archive, restore.
The desktop_db action and any other caller should import from here — not duplicate logic.
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import shutil
import subprocess
from collections.abc import Callable
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


# Number of snapshots to retain per instance, for BOTH ``flowpad_db_*`` DB
# backups and ``archive_*`` full archives. Each is a full copy (a DB file, or a
# DB + the entire records tree), so unbounded retention silently grows the
# instance dir into the tens of GB (oss hit 439 backups / 17 GB). Only the newest
# backup is ever used for recovery (``find_last_valid_db_backup``); keeping a
# handful gives a rollback margin. Override with ``FLOWPAD_BACKUP_RETENTION``
# (0 or negative disables pruning).
DEFAULT_BACKUP_RETENTION = 10


def _backup_retention() -> int:
    raw = os.environ.get("FLOWPAD_BACKUP_RETENTION")
    if raw is None or raw.strip() == "":
        return DEFAULT_BACKUP_RETENTION
    try:
        return int(raw)
    except ValueError:
        logger.warning(
            "Invalid FLOWPAD_BACKUP_RETENTION=%r; using default %d",
            raw, DEFAULT_BACKUP_RETENTION,
        )
        return DEFAULT_BACKUP_RETENTION


def _prune_snapshots(
    prefix: str,
    remove: Callable[[Path], None],
    label: str,
    keep: int | None,
    folder: Path | None,
) -> int:
    """Delete oldest ``<prefix>*`` entries in ``folder``, retaining the newest ``keep``.

    Timestamped names (``<prefix>YYYYMMDD_HHMMSS``) sort lexically in chronological
    order, so newest-first is a plain reverse sort — no mtime dependency. ``remove``
    deletes one entry (``Path.unlink`` for files, ``shutil.rmtree`` for dirs).
    ``folder`` defaults to :func:`get_backup_folder`; callers that already resolved
    it can pass it to skip the extra lookup. Returns the count deleted. Failures are
    logged and swallowed — a failed prune must never fail the op that triggered it.
    """
    if keep is None:
        keep = _backup_retention()
    if keep <= 0:
        return 0
    if folder is None:
        folder = get_backup_folder()
    entries = sorted(
        (p for p in folder.iterdir() if p.name.startswith(prefix)),
        key=lambda p: p.name,
        reverse=True,
    )
    removed = 0
    for stale in entries[keep:]:
        try:
            remove(stale)
            removed += 1
        except OSError as e:
            logger.warning("Failed to prune old %s %s: %s", label, stale, e)
    if removed:
        logger.info("Pruned %d old %s(s), kept newest %d", removed, label, keep)
    return removed


def prune_old_backups(keep: int | None = None, folder: Path | None = None) -> int:
    """Delete the oldest ``flowpad_db_*`` DB backup files, retaining the newest ``keep``.

    ``archive_*`` folders are left alone (see :func:`prune_old_archives`).
    """
    return _prune_snapshots("flowpad_db_", Path.unlink, "DB backup", keep, folder)


def prune_old_archives(keep: int | None = None, folder: Path | None = None) -> int:
    """Delete the oldest ``archive_*`` archive dirs, retaining the newest ``keep``.

    ``flowpad_db_*`` backup files are left alone (see :func:`prune_old_backups`).
    """
    return _prune_snapshots("archive_", shutil.rmtree, "archive", keep, folder)


async def backup_db() -> BackupResult:
    """Backup the SQLite database to the backups folder.

    After writing the new snapshot, prunes older ``flowpad_db_*`` backups down to
    the retention limit (:data:`DEFAULT_BACKUP_RETENTION`) so the backups folder
    stays bounded.
    """
    db_path = get_db_path()
    if not db_path.exists():
        raise FileNotFoundError("Database file does not exist")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = get_backup_folder() / f"flowpad_db_{timestamp}"
    shutil.copy2(db_path, backup_path)
    logger.info(f"Database backed up to: {backup_path}")

    prune_old_backups(folder=backup_path.parent)

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
    """Write a record_error FSRecord recording the DB corruption incident."""
    import uuid as _uuid  # noqa: PLC0415
    from datetime import datetime, timezone  # noqa: PLC0415

    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

    try:
        rec = FSRecord(
            type=RecordType.RECORD_ERROR,
            id=str(_uuid.uuid4()),
            trigger="ensure_db",
            error_type="DatabaseCorruption",
            error_message=(
                f"Database at {db_path} was malformed and no valid backup was found. "
                "The database has been reinitialised fresh — all previous data is lost."
            ),
            occurred_at=datetime.now(timezone.utc).isoformat(),
        )
        rec.save()
        logger.info("ensure_db: corruption record_error written")
    except Exception as e:
        logger.error(f"ensure_db: failed to write record_error: {e}")


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

    # 2. Cancel detached auto-index work while it still belongs to the current
    # graph. Otherwise a first-selection scan can keep its old writer alive
    # across the DB swap and race bootstrap with `BEGIN IMMEDIATE`.
    from flow_sdk.fs_store.indexer.auto_index import cancel_auto_indexes  # noqa: PLC0415

    await cancel_auto_indexes()

    # 3. Tear down every live PTY while its ComputeNode/provider identity is
    # still queryable. The DB wipe removes those rows, after which registry-only
    # cleanup can no longer reach the provider-owned OS child and workers leak
    # across factory resets.
    from flow_sdk.compute.providers.desktop.pty_session_manager import PtyRegistry  # noqa: PLC0415

    await PtyRegistry.get_instance().close_all_sessions()

    # 4. Clear the scan index (FTS + index logs + RecordErrors). Best-effort:
    # this queries the entity DB, and factory reset is exactly the operation
    # that must still work when that DB is broken (e.g. schema-less after an
    # interrupted clear). Its DB-row deletes are redundant with the wipe
    # below, but the on-disk index_log.jsonl cleanup is not — keep the call.
    try:
        await clear_index()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"clear_all_data: clear_index failed (continuing with wipe): {e}")

    # 5. Drop in-memory caches
    from flow_sdk.core.cache.entity_cache import entity_cache, uname_cache  # noqa: PLC0415

    entity_cache.clear()
    uname_cache.clear()

    # Capability system rows are wiped along with the DB below. No seed-guard
    # reset is needed: Capability._seeded_dbs is keyed on the live driver
    # object, and the reinit below constructs a fresh driver — the new DB
    # re-seeds on next access automatically.

    # 6. Close DB, delete file, reinitialize
    from flow_sdk.db.database import close_db, init_db  # noqa: PLC0415
    from flow_sdk.db.db_entity import DBEntity  # noqa: PLC0415
    from flow_sdk.db.db_relationship import DBRelationship  # noqa: PLC0415
    from flow_sdk.db.drivers.db_driver import (  # noqa: PLC0415
        _driver_instances,
        db_lifecycle_guard,
        get_db_driver,
        remove_db_sidecars,
    )

    async def _wipe_and_reinit() -> None:
        # Serialize the close→unlink→init→repoint block against overlapping
        # lifecycle swaps and fresh-session opens so no two engines can straddle
        # the unlink. Bootstrap deliberately runs after this guard; it takes
        # per-record locks and must preserve the normal record→session order.
        async with db_lifecycle_guard():
            # Close the SQLiteDriver's own engine before wiping the file
            sqlite_driver = _driver_instances.get("sqlite")
            if sqlite_driver is not None:
                await sqlite_driver.close()

            await close_db()
            db_path.unlink()
            remove_db_sidecars(db_path)
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

        # Rebuild @local immediately after the atomic file/driver swap, but
        # outside the lifecycle lock. Entity.save() takes a per-record sync
        # lock before it opens a DB session. Holding the lifecycle lock while
        # bootstrap seeds entities reverses that normal order and deadlocks
        # when a background writer already owns a record lock and is waiting
        # for the lifecycle swap to finish (capability discovery exposed this
        # on minute-boundary clears). Once the new driver is repointed, the
        # destructive swap is complete and normal record→session ordering can
        # safely resume.
        #
        # Without this rebuild, subsequent requests addressed via
        # `/compute_node/@local/...` cannot resolve `@local` and return
        # "Invalid request" until a client happens to call /bootstrap again.
        from flow_sdk.server.routes.bootstrap import (  # noqa: PLC0415
            bootstrap,
            invalidate_bootstrap_cache,
        )
        invalidate_bootstrap_cache()
        await bootstrap()

        # Rebuild the shipped system content through the same canonical pass as
        # process startup. The bootstrap() route handler above only restores the
        # @local graph; a factory reset also deletes the indexed system agents,
        # skills, whiteboards, and docs. Restoring only the project/markdown rows
        # leaves callers such as Vibe unable to resolve their bundled agent until
        # the whole process restarts.
        #
        # Await this pass: once the destructive reset response says "complete",
        # every shipped asset must already be queryable. The pass itself remains
        # best-effort, matching startup.
        try:
            from flow_sdk.server.routes.bootstrap import index_system_content  # noqa: PLC0415

            await index_system_content()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"clear_all_data: failed to re-seed system content (non-fatal): {e}")

    # The triggering HTTP request can be CANCELLED at any await (ASGI client
    # disconnect — e.g. the test runner being killed mid-clear). Without a
    # shield, the cancellation can land between ``db_path.unlink()`` and
    # ``init_db()`` completing, leaving a schema-less DB file that fails
    # EVERY query ("no such table: entities") until a process restart.
    # Shield the destructive section so once started it always runs to
    # completion, regardless of the caller's fate.
    await asyncio.shield(_wipe_and_reinit())

    return ClearAllResult(
        backup_path=backup.backup_path,
        message="All data has been cleared. A backup was created.",
    )


# ---------------------------------------------------------------------------
# Archive
# ---------------------------------------------------------------------------


async def archive() -> ArchiveResult:
    """Create a full archive: DB backup + records snapshot in a timestamped folder.

    After writing the new archive, prunes older ``archive_*`` dirs down to the
    retention limit (:data:`DEFAULT_BACKUP_RETENTION`) so the backups folder stays
    bounded — archives are heavier than plain DB snapshots (they also copy the
    whole records tree), so unbounded accumulation is the larger disk risk.
    """
    from flow_sdk.fs_store.record_paths import get_default_records_root  # noqa: PLC0415

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
    prune_old_archives(folder=archive_dir.parent)
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
    from flow_sdk.db.drivers.db_driver import db_lifecycle_guard, remove_db_sidecars  # noqa: PLC0415

    # Same dispose→swap-file→reinit shape as clear_all_data — serialize it
    # under the shared lifecycle lock so a restore can't straddle a concurrent
    # clear/path-switch (or a fresh session open) and leave an engine bound to
    # the just-overwritten file. The guard flags this coroutine so the nested
    # init_db / clear_index session opens bypass the non-reentrant lock.
    async def _swap_and_reinit() -> None:
        async with db_lifecycle_guard():
            await close_db()
            shutil.copy2(src, db_path)
            # The copied file pairs with the OLD inode's sidecars — same
            # "locking protocol" hazard as clear_all_data's unlink path.
            remove_db_sidecars(db_path)
            logger.info(f"Database restored from: {src}")

            entity_cache.clear()
            uname_cache.clear()

            await init_db()

            # Clear index — it no longer reflects the restored DB
            await clear_index()

    # Same cancellation exposure as clear_all_data: a client disconnect
    # mid-swap must not strand a half-restored DB. Run to completion.
    await asyncio.shield(_swap_and_reinit())

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
