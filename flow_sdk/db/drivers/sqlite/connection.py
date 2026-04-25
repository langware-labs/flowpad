"""SQLite connection and schema definitions for async SQLAlchemy."""

import os

# Configuration from environment
from pathlib import Path

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String, Text, event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

_default_db_path = str(Path.home() / ".flow" / "db" / "flowpad_db")
SQLITE_DATABASE_PATH = os.environ.get("SQLITE_DATABASE_PATH", _default_db_path)
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


async def create_engine_and_session(path: str = SQLITE_DATABASE_PATH):
    """Create async engine and session factory."""
    # Ensure the parent directory exists for file-based databases
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    url = get_database_url(path)
    engine = create_async_engine(url, echo=False)

    # Enable WAL mode and performance pragmas for concurrent access
    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()

    # Create tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )

    return engine, session_factory
