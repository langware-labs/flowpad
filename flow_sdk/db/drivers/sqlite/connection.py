"""SQLite connection and schema definitions for async SQLAlchemy."""

import sqlite3
from pathlib import Path
from typing import Literal
from urllib.parse import quote as _urlquote

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String, Text, event, text
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.orm import DeclarativeBase


def get_database_path() -> str:
    """Per-instance SQLite database path (call-time, via InstanceSettings).

    InstanceSettings already reads the SQLITE_DATABASE_PATH env var inside
    `from_env()` — never read the env here, that defeats the contract.
    """
    from flow_sdk.instance_settings import get_instance_settings
    return str(get_instance_settings().db_path)


def is_development() -> bool:
    """Return whether the current instance is the dev instance.

    Delegates to InstanceSettings (single source of truth). Replaces the
    legacy ``DEVELOPMENT`` module-level constant that snapshotted
    ``FLOWPAD_DEV`` at import time — same class-of-bug as the config.py
    env-mirror corruption: the value froze before ``.env.local`` could
    load, locking the instance to whatever ambient env said.
    """
    from flow_sdk.instance_settings import get_instance_settings
    return get_instance_settings().is_dev


class Base(DeclarativeBase):
    """Base class for all SQLAlchemy models."""

    pass


class EntitySchema(Base):
    """Schema for storing entities."""

    __tablename__ = "entities"

    id = Column(String(36), primary_key=True)
    type = Column(String(50), nullable=False, index=True)
    namespace = Column(String(255), index=True)
    key = Column(String(255), index=True)
    uname = Column(String(255), index=True)
    type_uname = Column(String(512), unique=True, nullable=True)
    created_by = Column(String(50))
    created_date = Column(DateTime)
    updated_by = Column(String(50))
    updated_date = Column(DateTime)
    created_through = Column(String(255))
    updated_through = Column(String(255))
    schema_version = Column(String(50))
    # Store dynamic fields as JSON text
    data = Column(Text)
    # Dedicated indexed column for Entity-to-Record lookup
    record_data_ref = Column(String(512), nullable=True, index=True)

    def to_dict(self) -> dict:
        """Convert schema to dictionary."""
        return {c.name: getattr(self, c.name) for c in self.__table__.columns}


class RelationshipSchema(Base):
    """Schema for storing relationships."""

    __tablename__ = "relationships"

    id = Column(String(36), primary_key=True)
    type = Column(String(50), nullable=False, index=True)
    from_id = Column(String(36), nullable=False, index=True)
    from_type = Column(String(50), nullable=False)
    to_id = Column(String(36), nullable=False, index=True)
    to_type = Column(String(50), nullable=False)
    created_by = Column(String(50))
    created_date = Column(DateTime)
    updated_by = Column(String(50))
    updated_date = Column(DateTime)
    created_through = Column(String(255))
    updated_through = Column(String(255))
    # Role-specific fields (denormalized for query performance)
    from_role = Column(String(50))
    to_role = Column(String(50))
    is_child = Column(Boolean, default=False)
    is_final = Column(Boolean, default=False)
    # Store additional dynamic fields as JSON text
    data = Column(Text)

    def to_dict(self) -> dict:
        """Convert schema to dictionary."""
        return {c.name: getattr(self, c.name) for c in self.__table__.columns}


class LinksSchema(Base):
    """Wiki links — one row per [[...]] occurrence in a source record's body."""

    __tablename__ = "links"

    id = Column(Integer, primary_key=True, autoincrement=True)
    src_type = Column(String(50), nullable=False)
    src_id = Column(String(36), nullable=False)
    target_raw = Column(Text, nullable=False)
    target_resolved_type = Column(String(50), nullable=True)
    target_resolved_id = Column(String(36), nullable=True)
    line = Column(Integer, nullable=False)

    __table_args__ = (
        Index("idx_links_src", "src_type", "src_id"),
        Index("idx_links_target", "target_resolved_type", "target_resolved_id"),
        Index(
            "idx_links_unresolved_raw",
            "target_raw",
            sqlite_where=text("target_resolved_id IS NULL"),
        ),
    )

    def to_dict(self) -> dict:
        """Convert schema to dictionary."""
        return {c.name: getattr(self, c.name) for c in self.__table__.columns}


def get_database_url(path: str | None = None) -> str:
    """Get the async SQLite database URL. Resolves per-instance default at call time."""
    if path is None:
        path = get_database_path()
    if path == ":memory:":
        # Use shared cache mode so all connections share the same database
        return "sqlite+aiosqlite:///:memory:?cache=shared"
    return f"sqlite+aiosqlite:///{path}"


def install_pragmas_and_immediate(engine: AsyncEngine) -> None:
    """Register the SQLite production pragmas + BEGIN IMMEDIATE on an engine.

    Pragmas (per-connection, set on every new aiosqlite connection):
      - journal_mode=WAL          readers concurrent with one writer
      - synchronous=NORMAL        safe with WAL, fsync only on checkpoint
      - busy_timeout=15000        15s wait on writer-lock contention
      - temp_store=MEMORY         temp tables in RAM
      - cache_size=-64000         64 MB page cache
      - mmap_size=268435456       256 MB memory-mapped I/O for reads
      - foreign_keys=ON           enforce FK constraints

    BEGIN IMMEDIATE on every transaction so SQLite acquires the writer
    lock up-front instead of upgrading mid-transaction. This eliminates
    the "SQLITE_BUSY despite busy_timeout" trap that fires when a
    deferred transaction starts as a reader and then tries to upgrade
    after another writer has taken the lock.
    """

    @event.listens_for(engine.sync_engine, "connect")
    def _on_connect(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        for stmt in (
            "PRAGMA journal_mode=WAL",
            "PRAGMA synchronous=NORMAL",
            "PRAGMA busy_timeout=15000",
            "PRAGMA temp_store=MEMORY",
            "PRAGMA cache_size=-64000",
            "PRAGMA mmap_size=268435456",
            # foreign_keys intentionally OFF: existing schema doesn't declare
            # FK constraints in the SQL DDL; they're enforced at app level.
            # Set explicitly so the sync ``open_sqlite`` and this async
            # ``_on_connect`` pragma set are documented-identical.
            "PRAGMA foreign_keys=OFF",
        ):
            cursor.execute(stmt)
        cursor.close()

    @event.listens_for(engine.sync_engine, "begin")
    def _on_begin(conn):
        conn.exec_driver_sql("BEGIN IMMEDIATE")


# Sync-side pragmas applied by ``open_sqlite``. Mirror the async engine's
# ``_on_connect`` set so a process that touches the same DB through both
# paths never mixes WAL with rollback-journal — the secondary corruption
# vector identified during the env-mirror RCA. ``foreign_keys=OFF`` matches
# the async side's documented choice (see ``_on_connect`` for the rationale);
# we set it explicitly here so the symmetry is documented in code rather than
# relying on SQLite's default.
_SYNC_PRAGMAS: tuple[str, ...] = (
    "PRAGMA journal_mode=WAL",
    "PRAGMA synchronous=NORMAL",
    "PRAGMA busy_timeout=15000",
    "PRAGMA temp_store=MEMORY",
    "PRAGMA cache_size=-64000",
    "PRAGMA mmap_size=268435456",
    "PRAGMA foreign_keys=OFF",
)


def open_sqlite(
    path: "Path | str | None" = None,
    *,
    mode: Literal["rw", "ro"] = "rw",
) -> sqlite3.Connection:
    """Open a sync SQLite connection with the project's standard pragmas.

    All raw ``sqlite3.connect`` sites in ``flow_sdk/`` route through this
    helper so the WAL + busy_timeout discipline is uniform — mixing pragma
    configurations on the same file is a documented SQLite corruption vector.

    ``path=None`` resolves to the current instance's main DB via
    ``get_database_path()``. ``mode="ro"`` opens read-only; on a read-only
    handle SQLite refuses ``journal_mode=WAL`` and ``foreign_keys`` writes,
    so we swallow those ``sqlite3.DatabaseError``s cleanly.
    """
    if path is None:
        path = get_database_path()
    # ``mode=rw`` refuses to create the file; raw ``sqlite3.connect(path)`` and
    # ``uri=file:?mode=rwc`` both create-on-open. Match the raw default so
    # callers migrating from plain ``sqlite3.connect`` see no behavior change.
    sqlite_mode = "rwc" if mode == "rw" else mode
    # Build a valid SQLite URI:
    #  - resolve to an absolute path with forward slashes (Windows backslashes
    #    are NOT valid in SQLite URI paths)
    #  - percent-encode `?`, `#`, `%`, ` `, etc. so they don't end the path
    #    component or be interpreted as URI control chars
    abs_path = Path(path).expanduser().resolve()
    encoded_path = _urlquote(abs_path.as_posix(), safe="/:")
    uri = f"file:{encoded_path}?mode={sqlite_mode}"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    for stmt in _SYNC_PRAGMAS:
        try:
            conn.execute(stmt)
        except sqlite3.DatabaseError:
            # Several pragmas (journal_mode=WAL, foreign_keys writes, ...) are
            # legitimately refused on a read-only handle. Swallow ONLY in that
            # case so typos in the pragma list still surface during dev.
            if mode != "ro":
                raise
    return conn


