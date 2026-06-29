from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, AsyncIterator

from flow_sdk.db.db_entity import DBEntity
from flow_sdk.db.db_relationship import DBRelationship
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.db.drivers.db_driver import (
    DBConfig,
    DBDriver,
    get_db_driver,
)
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


@asynccontextmanager
async def session(*, write: bool = True) -> "AsyncIterator[AsyncSession]":
    """Single canonical async DB session for the whole application.

    Inside an HTTP request: yields the request-bound session that the
    RequestTransactionMiddleware opened — commit/rollback/close happen
    automatically when the request finishes.

    Outside a request (CLI, scripts, tests, scheduled tasks): yields a
    fresh session that auto-commits on exit, rolls back on exception,
    and closes when the block ends.

    ``write=False`` requests reader semantics for a fresh session: no
    BEGIN IMMEDIATE, so SELECTs never queue on the SQLite writer lock
    (WAL snapshot reads). Use it ONLY for blocks that issue no writes —
    a write through a reader session falls back to a DBAPI deferred
    transaction and reintroduces the read→write upgrade trap. An ambient
    bound session is reused either way.

    Usage:
        from flow_sdk.db import session
        async with session() as s:
            ...
    """
    driver = get_db_driver()
    # Driver-level helpers that are not part of the public DBDriver protocol
    # (e.g. NetworkX driver) won't have _session_ctx; in that case fall back
    # to opening a one-off session via the factory.
    ctx = getattr(driver, "_session_ctx", None)
    if ctx is None:
        raise RuntimeError(
            "The active DB driver does not support the unified session() API. "
            "Use get_db_driver() directly for non-SQLite backends."
        )
    async with ctx(write=write) as s:
        yield s


# Aliases so callers can use whichever name they like.
Entity = DBEntity
Relationship = DBRelationship


__all__ = [
    "DBDriver",
    "DBConfig",
    "get_db_driver",
    "session",
    "DBEntity",
    "DBRelationship",
    "Entity",
    "Relationship",
    "BuiltinEntityType",
    "QueryFilter",
    "QueryOp",
    "ExpressionNode",
]
