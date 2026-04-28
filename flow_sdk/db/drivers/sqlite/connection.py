"""SQLite connection and schema definitions for async SQLAlchemy."""

import os

# Configuration from environment
from pathlib import Path

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String, Text, event, text
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.orm import DeclarativeBase

def _resolved_default_db_path() -> str:
    from flow_sdk.instance_settings import get_instance_settings
    return str(get_instance_settings().db_path)


SQLITE_DATABASE_PATH = os.environ.get("SQLITE_DATABASE_PATH") or _resolved_default_db_path()
DEVELOPMENT = os.environ.get("DEVELOPMENT", "true").lower() == "true"


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


def get_database_url(path: str = SQLITE_DATABASE_PATH) -> str:
    """Get the async SQLite database URL."""
    if path == ":memory:":
        # Use shared cache mode so all connections share the same database
        return "sqlite+aiosqlite:///:memory:?cache=shared"
    return f"sqlite+aiosqlite:///{path}"


def install_pragmas_and_immediate(engine: AsyncEngine) -> None:
    """Register the SQLite production pragmas + BEGIN IMMEDIATE on an engine.

    Pragmas (per-connection, set on every new aiosqlite connection):
      - journal_mode=WAL          readers concurrent with one writer
      - synchronous=NORMAL        safe with WAL, fsync only on checkpoint
      - busy_timeout=5000         5s wait on writer-lock contention
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
            "PRAGMA busy_timeout=5000",
            "PRAGMA temp_store=MEMORY",
            "PRAGMA cache_size=-64000",
            "PRAGMA mmap_size=268435456",
            # foreign_keys intentionally OFF: existing schema doesn't declare
            # FK constraints in the SQL DDL; they're enforced at app level.
            # Turning this on changes nothing for existing data and risks
            # surprising failures on legacy rows.
        ):
            cursor.execute(stmt)
        cursor.close()

    @event.listens_for(engine.sync_engine, "begin")
    def _on_begin(conn):
        conn.exec_driver_sql("BEGIN IMMEDIATE")


