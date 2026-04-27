"""Database initialization and session management.

Provides async session factory and database initialization utilities
for the flow-cli application.
"""

import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from flow_sdk.db.drivers.sqlite.connection import create_engine_and_session

logger = logging.getLogger(__name__)

# Global session factory - will be initialized on first use
_session_factory: Optional[async_sessionmaker] = None
_engine = None


async def init_db() -> None:
    """Initialize the database engine and create tables.

    Should be called once at application startup.
    """
    global _session_factory, _engine

    if _session_factory is not None:
        logger.debug("Database already initialized")
        return

    logger.info("Initializing database...")
    _engine, _session_factory = await create_engine_and_session()
    logger.info("Database initialized successfully")


async def close_db() -> None:
    """Dispose the database engine and clear the session factory.

    Should be called once at application shutdown.
    """
    global _session_factory, _engine
    engine = _engine
    # Clear globals first so callers see a clean state even if dispose() raises.
    _engine = None
    _session_factory = None
    if engine is not None:
        try:
            await engine.dispose()
        except Exception:
            pass


@asynccontextmanager
async def async_session():
    """Get a database session as an async context manager.

    Usage:
        async with async_session() as session:
            result = await session.execute(select(...))

    Raises:
        RuntimeError: If database has not been initialized
    """
    global _session_factory

    if _session_factory is None:
        await init_db()

    session: AsyncSession = _session_factory()
    try:
        yield session
    finally:
        await session.close()


async def reinit_db(new_path: str) -> None:
    """Hot-swap the SQLite database to a new path without restarting the server."""
    global _session_factory, _engine

    expanded = os.path.expanduser(new_path)

    await close_db()
    os.environ["SQLITE_DATABASE_PATH"] = expanded
    _engine, _session_factory = await create_engine_and_session(expanded)

    from flow_sdk.db.drivers.db_driver import _driver_instances

    driver = _driver_instances.get("sqlite")
    if driver is not None:
        await driver.close()
        driver.config.database = expanded
        await driver.open()

    from flow_sdk.core.cache.entity_cache import entity_cache, uname_cache

    entity_cache.clear()
    uname_cache.clear()


__all__ = ["init_db", "close_db", "async_session", "reinit_db"]
