"""SQLAlchemy/SQLite database driver for FlowPad testing."""

import json

DEFAULT_BROWSE_LIMIT = 20
import logging

logger = logging.getLogger(__name__)
import re
from collections import defaultdict
from contextlib import asynccontextmanager, nullcontext
from contextvars import ContextVar
from datetime import datetime
from typing import Any, AsyncIterator, Callable, Dict, List, Literal, Optional, Sequence, Set, Tuple

from fastapi import HTTPException
from sqlalchemy import and_, asc, delete, desc, func, or_, select, text, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from flow_sdk._compat import UTC
from flow_sdk.api.api_types.type_id import TypeId
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType, DBBaseRecord, DBBaseRelationship, EntityChild
from flow_sdk.db.drivers.db_driver import (
    _DB_LIFECYCLE_LOCK,
    DBConfig,
    DBDriver,
    DBResetProfile,
    _lifecycle_in_progress,
)
from flow_sdk.db.drivers.path_model import NodeConnection, NodesPath
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.flowpad_types.enums import RelationshipDirection


# TODO: request_context methods not available locally
def get_current_request_info():
    return None


class TransactionHandler:
    pass


from dataclasses import dataclass

from .connection import (
    Base,
    EntitySchema,
    RelationshipSchema,
    get_database_path,
    get_database_url,
    install_pragmas_and_immediate,
)

_standalone_session_var: "ContextVar[Optional[AsyncSession]]" = ContextVar(
    "_sqlite_driver_standalone_session", default=None
)


@dataclass
class FtsEntry:
    """A single record to be written into the FTS5 ``entities_fts`` table."""

    entity_id: str
    entity_type: str
    name: str | None = None
    title: str | None = None
    description: str | None = None
    content: str | None = None

    @classmethod
    def from_record(cls, entity_id: str, entity_type: str, name: str | None, record) -> "FtsEntry":
        """Build the entry from an ``FSRecord`` — the ONLY way callers should.

        ``title`` and ``description`` carry bm25 weights 8 and 3 (production is
        ``bm25(entities_fts, 0, 0, 10, 8, 3, 1)``), so a writer that omits them
        silently ranks its rows below identical content written elsewhere. Three
        call sites used to hand-roll this constructor and two of them had drifted
        to name+content only; funnelling them here makes "all four text columns"
        structural instead of a convention.

        Empty strings collapse to None so a record with no text anywhere still
        fails ``has_content`` and is skipped, exactly as before.
        """
        return cls(
            entity_id=entity_id,
            entity_type=entity_type,
            name=name or None,
            title=record.search_title or None,
            description=record.search_description or None,
            content=record.search_content or None,
        )

    @property
    def has_content(self) -> bool:
        return any(v is not None for v in (self.name, self.title, self.description, self.content))

    def as_params(self) -> dict:
        return {
            "entity_id": self.entity_id,
            "type": self.entity_type,
            "name": self.name or "",
            "title": self.title or "",
            "description": self.description or "",
            "content": self.content or "",
        }


@dataclass
class SearchCalibration:
    # BM25 column weights: [entity_id, type, name, title, description, content]
    col_weights: list[float] | None = None  # e.g. [0, 0, 10.0, 8.0, 3.0, 1.0]
    recency_boost: float | None = None  # e.g. 0.01 (per-day decay, SQL-side additive)
    type_scores: dict[str, float] | None = None  # e.g. {"skill": -2.0}
    # Python-side recency blend: blended = bm25 / (1 + days_old * recency_factor)
    recency_factor: float = 0.10  # e.g. 0.02 (2% per day); default 0.10 boosts recent results
    overfetch: int = 20  # extra rows to fetch beyond limit for blend (additive)


class SafeJSONEncoder(json.JSONEncoder):
    """JSON encoder that handles non-serializable types."""

    def default(self, obj):
        if isinstance(obj, re.Pattern):
            return obj.pattern
        if isinstance(obj, set):
            return list(obj)
        if isinstance(obj, frozenset):
            return list(obj)
        if isinstance(obj, bytes):
            return obj.decode("utf-8", errors="replace")
        if hasattr(obj, "isoformat"):
            return obj.isoformat()
        if hasattr(obj, "model_dump"):
            try:
                return obj.model_dump()
            except Exception:
                return str(obj)
        if hasattr(obj, "__dict__"):
            return str(obj)
        try:
            return super().default(obj)
        except TypeError:
            return str(obj)


logger = logging.getLogger(__name__)

# Distinguishes "no compare-and-set requested" from an expected value of None,
# which is itself a meaningful JSON comparison (field absent / null).
_UNSET = object()


class SQLiteTransactionHandler(TransactionHandler):
    """Transaction handler for SQLite async sessions."""

    def __init__(self, session: AsyncSession):
        self.db_transaction = session
        self._session = session

    async def start(self):
        """Start transaction - session is already started."""
        pass

    async def commit(self):
        """Commit the transaction."""
        await self._session.commit()

    async def rollback(self):
        """Rollback the transaction."""
        await self._session.rollback()

    async def close(self):
        """Close the session."""
        await self._session.close()


def _parse_vfs_uri_to_ref(vfs_uri: str) -> tuple[str, str]:
    """Parse a VFS URI into a (type, id) tuple.

    Example:
        ``"vfs://compute_node-@local/.../shell-@abc123"``
        -> ``("shell", "abc123")``

    Extracts the last path segment matching ``{type}-@{id}``.

    Raises:
        ValueError: If the URI does not contain a valid ``{type}-@{id}`` segment.
    """
    if not vfs_uri or not isinstance(vfs_uri, str):
        raise ValueError(f"Invalid VFS URI: {vfs_uri!r}")

    # Strip scheme
    path_part = vfs_uri
    if "://" in path_part:
        path_part = path_part.split("://", 1)[1]

    # Split into segments and find the last one with -@
    segments = [s for s in path_part.split("/") if s]
    for seg in reversed(segments):
        if "-@" in seg:
            record_type, uid = seg.split("-@", 1)
            if record_type and uid:
                return record_type, uid

    raise ValueError(f"No valid '{{type}}-@{{id}}' segment found in VFS URI: {vfs_uri!r}")


async def _migrate_vfs_record_to_data_ref(conn) -> None:
    """One-time DB migration: convert vfs_record JSON field to record_data_ref column.

    Finds Entity rows with ``vfs_record`` in their JSON ``data`` blob,
    parses the VFS URI to extract type/id, writes ``record_data_ref``,
    and removes ``vfs_record`` and ``vfs_orphan`` from the JSON data.
    """
    # Ensure record_data_ref column exists
    result = await conn.execute(text("PRAGMA table_info(entities)"))
    columns = [row[1] for row in result.fetchall()]
    if "record_data_ref" not in columns:
        await conn.execute(text("ALTER TABLE entities ADD COLUMN record_data_ref VARCHAR(512)"))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_entities_record_data_ref ON entities(record_data_ref)"))

    # Find rows with vfs_record in JSON data
    rows = await conn.execute(
        text("SELECT id, data FROM entities WHERE json_extract(data, '$.vfs_record') IS NOT NULL")
    )
    rows = rows.fetchall()

    for row_id, data_text in rows:
        if not data_text:
            continue
        try:
            data = json.loads(data_text)
        except (json.JSONDecodeError, TypeError):
            continue

        vfs_uri = data.get("vfs_record")
        if not vfs_uri:
            continue

        # Parse the VFS URI to get type/id for record_data_ref
        try:
            record_type, uid = _parse_vfs_uri_to_ref(vfs_uri)
            ref_value = f"{record_type}/{uid}"
        except ValueError:
            logger.warning("Skipping malformed VFS URI during migration: %s (entity %s)", vfs_uri, row_id)
            ref_value = None

        # Remove vfs_record and vfs_orphan from data blob
        data.pop("vfs_record", None)
        data.pop("vfs_orphan", None)
        new_data_text = json.dumps(data, cls=SafeJSONEncoder)

        if ref_value:
            await conn.execute(
                text("UPDATE entities SET data = :data, record_data_ref = :ref WHERE id = :id"),
                {"data": new_data_text, "ref": ref_value, "id": row_id},
            )
        else:
            await conn.execute(
                text("UPDATE entities SET data = :data WHERE id = :id"), {"data": new_data_text, "id": row_id}
            )

    # Also clean up rows that have vfs_orphan but no vfs_record
    orphan_rows = await conn.execute(
        text("SELECT id, data FROM entities WHERE json_extract(data, '$.vfs_orphan') IS NOT NULL")
    )
    orphan_rows = orphan_rows.fetchall()

    for row_id, data_text in orphan_rows:
        if not data_text:
            continue
        try:
            data = json.loads(data_text)
        except (json.JSONDecodeError, TypeError):
            continue
        data.pop("vfs_orphan", None)
        new_data_text = json.dumps(data, cls=SafeJSONEncoder)
        await conn.execute(
            text("UPDATE entities SET data = :data WHERE id = :id"), {"data": new_data_text, "id": row_id}
        )


# Per-class caches of derived field lists. Both are pure functions of the class
# (stable after class creation) but were recomputed on every save.
_PERSIST_FIELDS_CACHE: "dict[type, tuple[str, ...]]" = {}
_REL_PERSIST_FIELDS_CACHE: "dict[type, tuple[str, ...]]" = {}


class SQLiteDBDriver(DBDriver):
    """SQLAlchemy/SQLite database driver for testing."""

    # Fields that map directly to EntitySchema SQL columns — eligible for SQL pushdown.
    # Everything else lives in the JSON `data` blob and is queried via json_extract().
    _COLUMN_FIELDS: frozenset = frozenset(
        {
            "id",
            "type",
            "uname",
            "type_uname",
            "namespace",
            "key",
            "created_date",
            "updated_date",
            "created_by",
            "updated_by",
            "created_through",
            "updated_through",
            "schema_version",
        }
    )

    def __init__(self, cfg: Optional[DBConfig] = None):
        # Do NOT snapshot the per-instance db path here — defer to ``open()``
        # so a ``reinit_db`` / ``override_db_path`` swap is picked up by a
        # freshly-constructed driver. Callers that pass an explicit
        # ``DBConfig(database=...)`` (e.g. the session-scoped test driver)
        # keep their override because ``open()`` only resolves when
        # ``config.database`` is falsy.
        super().__init__(cfg or DBConfig())
        self.engine: Optional[AsyncEngine] = None
        self.session_factory: Optional[async_sessionmaker] = None
        # Read-only sessions: same engine/pool, but connections carry
        # ``FLOW_WRITER_OPT=False`` so the ``begin`` listener emits no
        # BEGIN — SELECTs run in DBAPI autocommit against a WAL snapshot
        # and never queue on the writer lock. See connection.py.
        self.reader_session_factory: Optional[async_sessionmaker] = None
        self.initialized_types: Set[str] = set()
        # Track whether ``config.database`` was provided by the caller vs.
        # lazy-resolved from settings on first ``open()``. ``close()`` drops
        # the lazy-resolved value so a subsequent ``open()`` re-reads the
        # current ``get_database_path()`` instead of pinning the stale path.
        # Callers passing explicit ``DBConfig(database=...)`` keep their
        # override across close/reopen cycles.
        self._database_was_lazy: bool = not bool(self.config.database)

    # ==================== Connection Management ====================

    async def open(self):
        """Initialize database connection."""
        if self.engine is not None:
            # Engine is alive, but a concurrent or partially-completed close()
            # may have nulled the session factory (it clears the factory before
            # awaiting engine.dispose()). Rebuild it from the live engine rather
            # than returning a driver that can't create sessions — otherwise
            # callers hit ``'NoneType' object is not callable`` at session_factory().
            if self.session_factory is None:
                self.session_factory = async_sessionmaker(self.engine, class_=AsyncSession, expire_on_commit=False)
            if self.reader_session_factory is None:
                self.reader_session_factory = self._make_reader_session_factory()
            return
        from sqlalchemy.ext.asyncio import create_async_engine
        from sqlalchemy.pool import AsyncAdaptedQueuePool, NullPool

        # Lazy per-instance resolution — see ``__init__`` for rationale.
        if not self.config.database:
            self.config.database = get_database_path()
            self._database_was_lazy = True
        db_path = self.config.database or ":memory:"
        url = get_database_url(db_path)
        # Pool connections by default. With NullPool every operation opened a
        # fresh aiosqlite connection (a new OS thread) and replayed six PRAGMAs
        # before doing any work — ~3.7ms of setup per operation, paid by every
        # DB call in the app, against ~0.02ms for the write itself.
        # ``DBConfig.pooled=False`` opts out; see there for who needs that.
        if self.config.pooled:
            self.engine = create_async_engine(
                url, echo=False, poolclass=AsyncAdaptedQueuePool, pool_size=2, max_overflow=8
            )
        else:
            self.engine = create_async_engine(url, echo=False, poolclass=NullPool)
        install_pragmas_and_immediate(self.engine)

        # Create tables
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            # Simple migration: add missing columns
            await self._migrate_schema(conn)

        self.session_factory = async_sessionmaker(self.engine, class_=AsyncSession, expire_on_commit=False)
        self.reader_session_factory = self._make_reader_session_factory()

    def _make_reader_session_factory(self) -> async_sessionmaker:
        """Session factory for read-only driver methods.

        Derives an option-engine from the live engine with
        ``FLOW_WRITER_OPT=False`` — same NullPool, same pragmas (engine
        events propagate to ``execution_options()`` copies), but the
        ``begin`` listener skips BEGIN IMMEDIATE so reads never take the
        SQLite writer lock (WAL gives each SELECT a consistent snapshot).
        """
        from flow_sdk.db.drivers.sqlite.connection import FLOW_WRITER_OPT  # noqa: PLC0415

        reader_engine = self.engine.execution_options(**{FLOW_WRITER_OPT: False})
        return async_sessionmaker(reader_engine, class_=AsyncSession, expire_on_commit=False)

    async def _migrate_schema(self, conn):
        """Simple schema migration: add missing columns."""
        result = await conn.execute(text("PRAGMA table_info(entities)"))
        columns = [row[1] for row in result.fetchall()]

        if "uname" not in columns:
            logger.info("Adding uname column to entities table")
            await conn.execute(text("ALTER TABLE entities ADD COLUMN uname VARCHAR(255)"))
            await conn.execute(text("CREATE INDEX ix_entities_uname ON entities(uname)"))
            logger.info("uname column added successfully")

        if "type_uname" not in columns:
            logger.info("Adding type_uname column to entities table")
            await conn.execute(text("ALTER TABLE entities ADD COLUMN type_uname VARCHAR(512)"))
            # Backfill from existing data
            await conn.execute(
                text(
                    "UPDATE entities SET type_uname = type || ':' || uname WHERE uname IS NOT NULL AND type_uname IS NULL"
                )
            )
            # Deduplicate: keep the oldest row per type_uname, NULL out the rest
            await conn.execute(
                text("""
                UPDATE entities SET type_uname = NULL
                WHERE uname IS NOT NULL
                  AND id NOT IN (
                    SELECT MIN(id) FROM entities
                    WHERE uname IS NOT NULL
                    GROUP BY type, uname
                  )
            """)
            )
            await conn.execute(text("CREATE UNIQUE INDEX ix_entities_type_uname ON entities(type_uname)"))
            logger.info("type_uname column added with unique constraint")

        # Migrate FTS5 table from 4-column to 6-column schema.
        # FTS5 doesn't support ALTER TABLE, so we drop and recreate.
        # The index is wiped; re-indexed on next POST /fs-records/index.
        try:
            result = await conn.execute(
                text("SELECT sql FROM sqlite_master WHERE type='table' AND name='entities_fts'")
            )
            row = result.fetchone()
            if row and row[0] and "title" not in row[0]:
                await conn.execute(text("DROP TABLE IF EXISTS entities_fts"))
        except Exception:
            pass
        # Create FTS5 virtual table (no triggers — populated by fts_upsert)
        await conn.execute(
            text("""
            CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
                entity_id, type, name, title, description, content,
                tokenize='porter unicode61'
            )
        """)
        )

        # Migrate vfs_record -> record_data_ref
        await _migrate_vfs_record_to_data_ref(conn)

        # Partial expression index powering per-(project, type) asset counts.
        # Indexes only the project/system-scoped rows (mirrors the project
        # predicate in `_scope_sql_clause`) and leads with the GROUP BY columns
        # (project_id, type) so SQLite streams the aggregate straight from the
        # index and skips the temp B-tree sort. ~25x on large indexes; see
        # scripts/bench_project_type_counts.py.
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_entities_project_type_counts "
                "ON entities(json_extract(data, '$.project_id'), type) "
                "WHERE json_extract(data, '$.scope') IN ('project', 'system') "
                "AND json_extract(data, '$.project_id') IS NOT NULL"
            )
        )

        # Partial expression index on a SourceItem's natural key. Ingestion
        # resolves every record by (data_source, stream, external id) rather
        # than by a derived id, and does it on EVERY poll to consult the digest
        # gate — the read that is supposed to cost one indexed lookup and
        # nothing else. These are JSON fields, not columns, so without this the
        # gate degrades to a full scan of the type: a 500-item page against a
        # source holding 50k records compares the IN list against every row,
        # every minute, forever.
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_entities_source_item_natural_key_v2 "
                "ON entities(json_extract(data, '$.data_source_id'), "
                "json_extract(data, '$.segment_key'), "
                "json_extract(data, '$.external_id')) "
                "WHERE type = 'source_item'"
            )
        )

        # Identity for a source-backed asset is resolved by ORIGIN, not by a
        # derived id — `reflect._find_by_origin` asks every file-backed type
        # whether it holds this handle, on every observed ref. There is no
        # cross-type query path (an untyped `get_all` returns nothing), so the
        # fan-out is unavoidable and each arm must at least be indexed;
        # otherwise one changed file costs ~26 full type scans.
        #
        # Neither type-partial nor value-partial, deliberately. The fan-out
        # spans every owner type, so one expression index serves all of them —
        # and a `WHERE origin_id != ''` predicate is NOT provably implied by an
        # equality lookup, so SQLite silently declines the partial index and
        # falls back to the type scan. Verified with EXPLAIN QUERY PLAN.
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_entities_origin_id "
                "ON entities(json_extract(data, '$.origin_id'))"
            )
        )

        # The same lookup for cursors: `ensure_for` resolves one per stream per
        # source on every poll, and `data_source_id` alone is selective enough
        # (a source has streams in the tens, not thousands).
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_entities_cursor_by_source "
                "ON entities(json_extract(data, '$.data_source_id')) "
                "WHERE type = 'data_source_cursor'"
            )
        )

        # "Who owns this path" — `Entity.get_by_asset_ref`, and now every
        # identity resolution that recovers a wiped carrier instead of minting a
        # fork. It ran as a full scan PER owner type, and the watcher path calls
        # it on every file change.
        #
        # Deliberately NOT UNIQUE. The invariant IS one path = one live row, but
        # enforcing it here would turn any residual duplicate into an
        # IntegrityError on the user's hot path mid-index, and the collapse
        # migration needs a window in which two rows briefly coexist. The
        # constraint is the resolver; this index makes violations cheap to find
        # (GROUP BY … HAVING COUNT(*) > 1).
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_entities_asset_ref "
                "ON entities(json_extract(data, '$.asset_ref')) "
                "WHERE json_extract(data, '$.asset_ref') IS NOT NULL"
            )
        )

    async def close(self):
        """Close database connection and ensure worker threads stop."""
        if self.engine:
            # Null both references synchronously BEFORE the await on dispose().
            # engine.dispose() yields the event loop; if another coroutine ran
            # _session_ctx() in that window with engine!=None but factory=None,
            # open()'s early-return would skip rebuilding and the caller would
            # call None(). Clearing engine here too means a concurrent open()
            # sees a fully-closed driver and rebuilds cleanly.
            engine = self.engine
            self.session_factory = None
            self.reader_session_factory = None
            self.engine = None
            # Dispose the engine — closes all pooled connections + worker threads.
            await engine.dispose()
        # Drop the lazily-resolved path so the next ``open()`` re-reads
        # ``get_database_path()`` — picks up any ``override_db_path`` swap
        # that landed after the previous open. Callers who passed an
        # explicit ``DBConfig(database=...)`` keep their override.
        if self._database_was_lazy:
            self.config.database = None

    # ==================== FTS5 Full-Text Search ====================

    async def _fts_delete_batch(self, session, entity_ids: list, batch_size: int) -> None:
        """DELETE FTS rows for ``entity_ids``, chunked to stay under SQLite param limit."""
        for i in range(0, len(entity_ids), batch_size):
            chunk = entity_ids[i : i + batch_size]
            placeholders = ", ".join(f":id_{j}" for j in range(len(chunk)))
            params = {f"id_{j}": eid for j, eid in enumerate(chunk)}
            await session.execute(
                text(f"DELETE FROM entities_fts WHERE entity_id IN ({placeholders})"),
                params,
            )

    async def _fts_insert_batch(self, session, entries: list, batch_size: int) -> None:
        """Multi-row INSERT into FTS, chunked so total params stay under SQLite limit.

        Each entry occupies 6 bind parameters, so the effective chunk size is
        ``batch_size // 6``.
        """
        entries_per_chunk = max(1, batch_size // 6)
        for i in range(0, len(entries), entries_per_chunk):
            chunk = entries[i : i + entries_per_chunk]
            value_rows = []
            params: dict = {}
            for j, e in enumerate(chunk):
                p = e.as_params()
                value_rows.append(f"(:entity_id_{j}, :type_{j}, :name_{j}, :title_{j}, :description_{j}, :content_{j})")
                params[f"entity_id_{j}"] = p["entity_id"]
                params[f"type_{j}"] = p["type"]
                params[f"name_{j}"] = p["name"]
                params[f"title_{j}"] = p["title"]
                params[f"description_{j}"] = p["description"]
                params[f"content_{j}"] = p["content"]
            await session.execute(
                text(
                    "INSERT INTO entities_fts(entity_id, type, name, title, description, content) VALUES "
                    + ", ".join(value_rows)
                ),
                params,
            )

    async def fts_upsert(self, entry: "FtsEntry | list[FtsEntry]", batch_size: int = 500) -> None:
        """Insert or replace one or more rows in the FTS5 ``entities_fts`` table.

        Accepts a single FtsEntry or a list. All entries share one connection
        open/close cycle. No-op when the list is empty or all entries lack content.

        ``batch_size`` controls the maximum number of bind parameters per SQL
        statement — kept well below SQLite's default limit of 999.
        """
        if not self.session_factory:
            return

        entries = [entry] if isinstance(entry, FtsEntry) else entry
        entries = [e for e in entries if e.has_content]
        if not entries:
            return

        async with self._session_ctx() as session:
            await self._fts_delete_batch(session, [e.entity_id for e in entries], batch_size)
            await self._fts_insert_batch(session, entries, batch_size)

    async def fts_search(
        self,
        query: str,
        limit: int = 10,
        record_type: str | None = None,
        status: str | None = None,
        calibration: "SearchCalibration | None" = None,
    ) -> list:
        """Execute FTS5 MATCH query and return hydrated Entity objects."""
        if not query or not self.session_factory:
            return []
        # Append * to each term for prefix matching (so "poin" matches "pointer").
        # Terms with FTS5 special chars (. + ^ : etc.) must be double-quoted so the
        # tokenizer sees them as phrase searches rather than syntax errors.
        _FTS5_SPECIAL = frozenset(".+^(){}[]~?\\/:!-")

        def _fts_term(t: str) -> str:
            already_prefix = t.endswith("*")
            bare = t.rstrip("*")
            if any(c in bare for c in _FTS5_SPECIAL):
                # Escape any embedded double-quotes in the term, then quote it.
                # Don't add * — prefix search on a dotted version string is not useful.
                escaped = bare.replace('"', '""')
                return f'"{escaped}"'
            return t if already_prefix else t + "*"

        fts_query = " ".join(_fts_term(t) for t in query.split())
        async with self._session_ctx(write=False) as session:
            # Build the SQL — snippet() on title (col 3) and content (col 5)
            # Columns: 0=entity_id, 1=type, 2=name, 3=title, 4=description, 5=content
            cal = calibration or SearchCalibration()

            # BM25 expression (reused in SELECT and ORDER BY)
            if cal.col_weights and len(cal.col_weights) == 6:
                w = cal.col_weights
                bm25_expr = f"bm25(entities_fts, {w[0]}, {w[1]}, {w[2]}, {w[3]}, {w[4]}, {w[5]})"
            else:
                bm25_expr = "bm25(entities_fts, 0, 0, 10, 8, 3, 1)"

            sql = f"""
                SELECT e.*,
                       fts.title AS _fts_title,
                       fts.description AS _fts_description,
                       snippet(entities_fts, 3, '<mark>', '</mark>', '…', 32) AS _fts_snippet_title,
                       snippet(entities_fts, 5, '<mark>', '</mark>', '…', 32) AS _fts_snippet_content,
                       {bm25_expr} AS _bm25_score
                FROM entities e
                JOIN entities_fts fts ON e.id = fts.entity_id
                WHERE entities_fts MATCH :query
            """
            # Fetch extra rows when overfetch is set (for Python-side recency blend)
            fetch_limit = limit + (cal.overfetch or 0)
            params: dict[str, Any] = {"query": fts_query, "limit": fetch_limit}
            if record_type:
                sql += " AND e.type = :record_type"
                params["record_type"] = record_type
            if status:
                sql += " AND json_extract(e.data, '$.status') = :status"
                params["status"] = status

            order_parts = [bm25_expr]

            # SQL-side additive recency penalty (older = larger positive value added = worse rank)
            if cal.recency_boost:
                order_parts.append("(julianday('now') - julianday(e.updated_date)) * :recency_boost")
                params["recency_boost"] = cal.recency_boost

            # Type score boost
            if cal.type_scores:
                cases = " ".join(f"WHEN '{t}' THEN :type_score_{t}" for t in cal.type_scores)
                order_parts.append(f"CASE e.type {cases} ELSE 0.0 END")
                for t, v in cal.type_scores.items():
                    params[f"type_score_{t}"] = v

            sql += f" ORDER BY {' + '.join(order_parts)}, e.updated_date DESC LIMIT :limit"

            result = await session.execute(text(sql), params)
            rows = result.fetchall()
            columns = result.keys()

            entity_cols = {col.name for col in EntitySchema.__table__.columns}
            entities_with_score: list[tuple[float, Any]] = []
            for row in rows:
                row_dict = dict(zip(columns, row))
                fts_title = row_dict.pop("_fts_title", None) or None
                fts_description = row_dict.pop("_fts_description", None) or None
                snippet_title = row_dict.pop("_fts_snippet_title", None) or None
                snippet_content = row_dict.pop("_fts_snippet_content", None) or None
                bm25_score = row_dict.pop("_bm25_score", 0.0) or 0.0
                # Use title snippet if the match is in title; fall back to content snippet
                snippet_val = snippet_title if snippet_title and "<mark>" in (snippet_title or "") else snippet_content
                # Filter to columns EntitySchema knows — stale DBs can have extra
                # leftover columns (e.g. old ``content_hash``) that would crash kwargs.
                schema = EntitySchema(**{k: v for k, v in row_dict.items() if k in entity_cols})
                try:
                    entity = self._schema_to_entity(schema)
                    entity._fts_snippet = snippet_val  # type: ignore[attr-defined]
                    entity._fts_title = fts_title  # type: ignore[attr-defined]
                    entity._fts_description = fts_description  # type: ignore[attr-defined]
                    entities_with_score.append((bm25_score, entity))
                except Exception:
                    logger.warning("FTS search: failed to hydrate entity %s", row_dict.get("id"))

        # Python-side recency blend: blended = bm25 / (1 + days_old * k)
        if cal.recency_factor and entities_with_score:
            from datetime import datetime  # noqa: PLC0415

            k = cal.recency_factor
            now = datetime.now(UTC)

            def _blend(item: tuple[float, Any]) -> float:
                bm25, ent = item
                upd = getattr(ent, "updated_date", None)
                if upd:
                    try:
                        dt = datetime.fromisoformat(str(upd))
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=UTC)
                        days = max(0.0, (now - dt).total_seconds() / 86400)
                    except Exception:
                        days = 365.0
                else:
                    days = 365.0
                return bm25 / (1 + days * k)

            entities_with_score.sort(key=_blend)

        return [ent for _, ent in entities_with_score[:limit]]

    async def browse_by_type(
        self,
        entity_type: str | None,
        limit: int | None = DEFAULT_BROWSE_LIMIT,
        status: str | None = None,
        *,
        offset: int = 0,
        sort_by: Literal["updated_date", "last_edited_at"] = "updated_date",
        entity_types: Sequence[str] | None = None,
    ) -> list[Any]:
        """Return browse entities with FTS metadata, ordered in SQLite.

        Unlike fts_search this does not require a query — it is used for
        filter-only browsing. ``entity_types`` is the server-computed eligibility
        set for a mixed projection; it is never accepted directly from clients.
        Uses LEFT JOIN so entities without an FTS row are still returned.
        """
        entities, _ = await self.browse_page(
            entity_type=entity_type,
            limit=limit,
            status=status,
            offset=offset,
            sort_by=sort_by,
            entity_types=entity_types,
        )
        return entities

    async def browse_page(
        self,
        entity_type: str | None,
        limit: int | None = DEFAULT_BROWSE_LIMIT,
        status: str | None = None,
        *,
        offset: int = 0,
        sort_by: Literal["updated_date", "last_edited_at"] = "updated_date",
        entity_types: Sequence[str] | None = None,
        scope: object | None = None,
        include_system: bool = True,
    ) -> tuple[list[Any], int]:
        """Return a SQL-paged browse projection and its pre-page total."""
        if not self.session_factory or (entity_type is None and entity_types is None):
            return [], 0
        if sort_by not in ("updated_date", "last_edited_at"):
            raise ValueError(f"Unsupported browse sort field: {sort_by!r}")

        eligible_types = sorted({str(t).lower() for t in entity_types or () if t})
        if entity_types is not None and not eligible_types:
            return [], 0

        async with self._session_ctx(write=False) as session:
            # Apply LIMIT *before* joining entities_fts. FTS5 has no usable
            # B-tree index on plain columns like entity_id, so joining the
            # full type-filtered set against the virtual table degrades to
            # O(matched_rows × fts_rows) — a 1346-row type took ~12s with a
            # 3812-row FTS table. Hoisting the LIMIT into a subquery caps
            # the join at LIMIT rows.
            clauses: list[str] = []
            params: dict[str, Any] = {}
            if entity_type is not None:
                clauses.append("type = :entity_type")
                params["entity_type"] = entity_type.lower()
            if entity_types is not None:
                type_params = []
                for index, eligible_type in enumerate(eligible_types):
                    key = f"eligible_type_{index}"
                    type_params.append(f":{key}")
                    params[key] = eligible_type
                clauses.append(f"type IN ({', '.join(type_params)})")
            if status:
                clauses.append("json_extract(data, '$.status') = :status")
                params["status"] = status
            if sort_by == "last_edited_at":
                clauses.extend(
                    [
                        "json_type(data, '$.last_edited_at') IN ('integer', 'real')",
                        "json_extract(data, '$.last_edited_at') > 0",
                    ]
                )

            where_sql = " AND ".join(clauses)
            where_sql += self._scope_sql_clause(scope, params, entity_type)
            if not include_system:
                scope_project_ids = tuple(
                    dict.fromkeys(
                        (
                            *(getattr(scope, "projects", ()) or ()),
                            *(getattr(scope, "record_projects", ()) or ()),
                        )
                    )
                )
                system_clause = "COALESCE(json_extract(data, '$.system'), 0) = 0"
                if scope_project_ids:
                    project_params = []
                    for index, project_id in enumerate(scope_project_ids):
                        key = f"system_scope_project_{index}"
                        project_params.append(f":{key}")
                        params[key] = project_id
                    system_clause = (
                        f"({system_clause} OR json_extract(data, '$.project_id') "
                        f"IN ({', '.join(project_params)}))"
                    )
                where_sql += f" AND ({system_clause})"

            sort_expr = (
                "json_extract(data, '$.last_edited_at')"
                if sort_by == "last_edited_at"
                else "updated_date"
            )
            count_result = await session.execute(
                text(f"SELECT COUNT(*) FROM entities WHERE {where_sql}"),
                params,
            )
            total = int(count_result.scalar() or 0)

            inner_sql = f"SELECT * FROM entities WHERE {where_sql}"
            inner_sql += f" ORDER BY {sort_expr} DESC, type ASC, id ASC"
            if limit is not None:
                inner_sql += " LIMIT :limit OFFSET :offset"
                params["limit"] = limit
                params["offset"] = offset
            sql = f"""
                SELECT e.*,
                       fts.title AS _fts_title,
                       fts.description AS _fts_description
                FROM ({inner_sql}) e
                LEFT JOIN entities_fts fts ON e.id = fts.entity_id
                ORDER BY {
                    "json_extract(e.data, '$.last_edited_at')"
                    if sort_by == "last_edited_at"
                    else "e.updated_date"
                } DESC, e.type ASC, e.id ASC
            """
            result = await session.execute(text(sql), params)
            rows = result.fetchall()
            columns = result.keys()
            entity_cols = {col.name for col in EntitySchema.__table__.columns}
            entities: list[Any] = []
            for row in rows:
                row_dict = dict(zip(columns, row))
                fts_title = row_dict.pop("_fts_title", None) or None
                fts_description = row_dict.pop("_fts_description", None) or None
                schema = EntitySchema(**{k: v for k, v in row_dict.items() if k in entity_cols})
                try:
                    entity = self._schema_to_entity(schema)
                    entity._fts_title = fts_title  # type: ignore[attr-defined]
                    entity._fts_description = fts_description  # type: ignore[attr-defined]
                    entities.append(entity)
                except Exception:
                    logger.warning("browse_by_type: failed to hydrate entity %s", row_dict.get("id"))
            return entities, total

    async def fts_delete(self, entity_id: str) -> None:
        """Remove a row from ``entities_fts``."""
        if not self.session_factory:
            return
        async with self._session_ctx() as session:
            await session.execute(
                text("DELETE FROM entities_fts WHERE entity_id = :entity_id"), {"entity_id": entity_id}
            )

    async def fts_clear(self) -> int:
        """Delete all rows from ``entities_fts``. Returns the number of rows deleted."""
        if not self.session_factory:
            return 0
        try:
            async with self._session_ctx() as session:
                result = await session.execute(text("SELECT COUNT(*) FROM entities_fts"))
                count = result.scalar() or 0
                await session.execute(text("DELETE FROM entities_fts"))
                return int(count)
        except Exception as e:
            logger.warning("fts_clear() failed: %s", e)
            return 0

    @staticmethod
    def _scope_sql_clause(
        scope: "object | None",
        bindings: dict,
        type_name: str | None = None,
    ) -> str:
        """Translate the server-side ScopeFilter predicate (search_filters.py)
        into a SQL fragment for ANDing into WHERE clauses.

        Mirrors ``apply_scope_filter`` exactly:
          - scope='user'              kept iff sf.user
          - scope IN ('project','system') kept iff project_id IN sf.projects/record_projects
            (system rows carry the system project's id, so selecting that project
            surfaces them; they stay hidden otherwise)
          - scope is empty/missing → kept only for non-scoped record types

        Returns "" when scope is None (caller-side opt-out). Mutates
        ``bindings`` to add any new bind parameters.
        """
        if scope is None:
            return ""
        from flow_sdk.server.search_filters import (  # noqa: PLC0415
            PROJECT_LIKE_SCOPES,
            SCOPED_RECORD_TYPES,
        )

        keep_user = bool(getattr(scope, "user", False))
        entity_projects = tuple(getattr(scope, "projects", ()) or ())
        record_projects = tuple(getattr(scope, "record_projects", ()) or ())
        projects = tuple(dict.fromkeys((*entity_projects, *record_projects)))
        clauses: list[str] = []
        empty_scope = "(json_extract(data, '$.scope') IS NULL OR json_extract(data, '$.scope') = '')"
        if type_name:
            if type_name not in SCOPED_RECORD_TYPES:
                clauses.append(empty_scope)
        else:
            scoped_type_placeholders = []
            for i, record_type in enumerate(sorted(SCOPED_RECORD_TYPES)):
                key = f"__sf_scoped_type_{i}"
                bindings[key] = record_type
                scoped_type_placeholders.append(f":{key}")
            clauses.append(f"({empty_scope} AND type NOT IN ({','.join(scoped_type_placeholders)}))")
        if keep_user:
            clauses.append("json_extract(data, '$.scope') = 'user'")
        if projects:
            placeholders = []
            for i, pid in enumerate(projects):
                key = f"__sf_pid_{i}"
                bindings[key] = pid
                placeholders.append(f":{key}")
            scope_placeholders = []
            for i, scope_val in enumerate(sorted(PROJECT_LIKE_SCOPES)):
                key = f"__sf_scope_{i}"
                bindings[key] = scope_val
                scope_placeholders.append(f":{key}")
            clauses.append(
                f"(json_extract(data, '$.scope') IN ({','.join(scope_placeholders)}) AND "
                f"json_extract(data, '$.project_id') IN ({','.join(placeholders)}))"
            )
        # Without `user` and without any projects, only non-scoped record
        # types can still match via the empty-scope branch above.
        if not clauses:
            return " AND (0=1)"
        return " AND (" + " OR ".join(clauses) + ")"

    async def count_entities_by_type(
        self,
        type_name: str | None = None,
        scope: "object | None" = None,
    ) -> int:
        """Count entities, optionally filtered by type and/or ScopeFilter."""
        if not self.session_factory:
            return 0
        bindings: dict = {}
        type_clause = ""
        if type_name:
            type_clause = "WHERE type = :type"
            bindings["type"] = type_name
        scope_clause = self._scope_sql_clause(scope, bindings, type_name)
        if scope_clause and not type_clause:
            # Need a WHERE for the AND-prefix to bind correctly.
            scope_clause = " WHERE " + scope_clause.lstrip(" AND ")
        sql = f"SELECT COUNT(*) FROM entities {type_clause}{scope_clause}"
        async with self._session_ctx(write=False) as session:
            result = await session.execute(text(sql), bindings)
            return result.scalar() or 0

    async def list_entity_sources_by_type(
        self,
        type_name: str,
    ) -> dict[str, tuple[str | None, str | None, str | None, list | None, datetime | None]]:
        """Return source/provenance/collision state for every row of a type."""
        if not self.session_factory:
            return {}
        sql = (
            "SELECT id, json_extract(data, '$.asset_ref'), "
            "json_extract(data, '$.scope'), json_extract(data, '$.project_id'), "
            "json_extract(data, '$.asset_occurrences'), created_date "
            "FROM entities WHERE type = :type"
        )
        async with self._session_ctx(write=False) as session:
            result = await session.execute(text(sql), {"type": type_name})
            out = {}
            for row in result.fetchall():
                occurrences = row[4]
                if isinstance(occurrences, str):
                    try:
                        occurrences = json.loads(occurrences)
                    except ValueError:
                        occurrences = None
                out[str(row[0])] = (row[1], row[2], row[3], occurrences, row[5])
            return out

    async def delete_entities_by_type(
        self,
        type_name: str | None = None,
        scope: "object | None" = None,
    ) -> int:
        """Delete entities (and their FTS rows) by type, optionally narrowed
        by ScopeFilter. None for both = all anonymous entities."""
        if not self.session_factory:
            return 0
        bindings: dict = {}
        if type_name:
            bindings["type"] = type_name
            base_where = "type = :type"
        else:
            # Preserve named (builtin) entities like @local — only clear anonymous indexed records
            base_where = "uname IS NULL"
        scope_clause = self._scope_sql_clause(scope, bindings, type_name)
        where_clause = base_where + scope_clause
        async with self._session_ctx() as session:
            await session.execute(
                text(f"DELETE FROM entities_fts WHERE entity_id IN (SELECT id FROM entities WHERE {where_clause})"),
                bindings,
            )
            result = await session.execute(text(f"DELETE FROM entities WHERE {where_clause}"), bindings)
            return result.rowcount or 0

    async def create_db(self):
        """Create database tables."""
        if self.engine:
            async with self.engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)

    def get_transaction_factory(self) -> Callable[[], TransactionHandler]:
        """Return factory for creating transaction handlers."""

        def factory():
            if not self.session_factory:
                raise RuntimeError("Database not opened. Call open() first.")
            session = self.session_factory()
            return SQLiteTransactionHandler(session)

        return factory

    async def start_transaction(self, handler: TransactionHandler):
        """Start a transaction."""
        pass  # Session handles this automatically

    @staticmethod
    async def close_transaction(handler: TransactionHandler):
        """Close a transaction."""
        await handler.commit()
        await handler.close()

    @staticmethod
    async def rollback_transaction(handler: TransactionHandler):
        """Rollback a transaction."""
        await handler.rollback()
        await handler.close()

    def validate_schema(self, schemas: List[Dict[str, Any]]) -> None:
        """Validate that entity schemas match database schema.

        Checks that all base fields from DBBaseRecord are either:
        - Direct columns in EntitySchema, OR
        - Stored in the data JSON column

        Raises ValueError if base fields are lost (not in columns and excluded from JSON).
        """
        # Get EntitySchema column names
        entity_columns = {col.name for col in EntitySchema.__table__.columns}

        # Get base fields from DBBaseRecord (these should be in columns or JSON data)
        # Already imported at top

        base_fields = set(DBBaseRecord.model_fields.keys())

        # Fields that are excluded from JSON data by _get_entity_data_dict
        # (base_fields are excluded - see line 1227-1232)
        excluded_from_json = base_fields

        # Check each base field
        problematic_fields = []
        for field_name in base_fields:
            in_columns = field_name in entity_columns
            in_json = field_name not in excluded_from_json

            if not in_columns and not in_json:
                problematic_fields.append(field_name)

        if problematic_fields:
            raise ValueError(
                f"Schema validation failed: The following base fields are not stored in database columns "
                f"and are excluded from JSON data, causing data loss: {', '.join(problematic_fields)}. "
                f"These fields should either be added as columns to EntitySchema or included in the JSON data."
            )

    async def _get_session(self) -> AsyncSession:
        """Get a database session. Auto-opens if not already open."""
        if not self.session_factory:
            await self.open()
        return self.session_factory()

    @asynccontextmanager
    async def _session_ctx(self, *, write: bool = True) -> "AsyncIterator[AsyncSession]":
        """Single canonical session context for driver methods.

        ``write`` selects the transaction discipline for a FRESH session:
        writer sessions (default) BEGIN IMMEDIATE up-front; reader sessions
        (``write=False``, used by SELECT-only driver methods) emit no BEGIN
        at all so they never queue on the SQLite writer lock (WAL snapshot
        reads). An ambient bound session is always reused regardless of
        ``write`` — with one exception, see (2).

        Resolution order:

        1. Request-bound session (set by RequestTransactionMiddleware via
           SQLiteTransactionHandler.db_transaction): yield it. Do NOT commit
           or close — the middleware owns the lifecycle.

        2. Standalone-task-bound session (set by an outer call to
           _session_ctx() in the same task): yield it. The outer caller
           commits/closes when its block exits. EXCEPTION: a write request
           never reuses an ambient READER session — writing through a
           no-BEGIN connection would fall back to a DBAPI-level deferred
           transaction and reintroduce the read→write upgrade trap that
           BEGIN IMMEDIATE exists to prevent. It falls through and opens a
           fresh writer session instead.

        3. No bound session: open a fresh one (writer or reader factory per
           ``write``), register it as the standalone task-bound session,
           commit on success, rollback on exception, close on exit.

        The contextvar handoff in (2) prevents nested driver calls in the
        same task from racing for the SQLite writer lock against themselves.
        """
        bound = None
        try:
            from flow_sdk.request_context.methods import get_current_transaction  # noqa: PLC0415

            bound = get_current_transaction()
        except Exception:
            bound = None
        if bound is not None and isinstance(bound, AsyncSession):
            yield bound
            return
        standalone = _standalone_session_var.get()
        if standalone is not None and not (write and standalone.info.get("flow_reader")):
            yield standalone
            return
        # Gate ONLY the factory-resolution + session-open against the DB
        # lifecycle lock (NOT the whole query): a destructive clear/restore/
        # path-switch must not unlink/swap the file while a fresh session is
        # being born on the old engine. Holding the lock here means a waiting
        # lifecycle mutator cannot proceed to dispose+unlink until no new
        # session is mid-open; combined with the mutator's own engine dispose
        # (which reaps idle conns), this closes the deleted-file-engine window
        # for the dominant fresh-session path. We release before yielding so
        # the query itself never holds the lifecycle lock.
        #
        # The lifecycle mutator's OWN coroutine sets _lifecycle_in_progress
        # while it holds the lock (see db_lifecycle_guard); its nested opens
        # (init_db / bootstrap rebuild / clear_index) must bypass here or they
        # would re-acquire this non-reentrant lock and self-deadlock.
        lock_ctx = nullcontext() if _lifecycle_in_progress.get() else _DB_LIFECYCLE_LOCK
        async with lock_ctx:
            if not self.session_factory:
                await self.open()
            factory = (
                self.session_factory
                if write
                else (getattr(self, "reader_session_factory", None) or self.session_factory)
            )
            session = factory()
            if not write:
                session.info["flow_reader"] = True
        async with session:
            token = _standalone_session_var.set(session)
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
            finally:
                _standalone_session_var.reset(token)

    # ==================== Entity CRUD ====================

    async def save(self, entity: DBBaseRecord, owner: TypeId | None = None) -> DBBaseRecord:
        """Save entity (create or update)."""
        async with self._session_ctx() as session:
            # Check if entity exists by ID
            result = await session.execute(select(EntitySchema).where(EntitySchema.id == entity.id))
            existing = result.scalar_one_or_none()

            if existing:
                # If the incoming entity lacks audit fields (e.g. race-condition create),
                # carry them over from the persisted row so _update_entity doesn't reject it.
                if not entity.created_by:
                    entity.created_by = existing.created_by
                if not entity.created_date:
                    entity.created_date = existing.created_date
                return await self._update_entity(entity, session)

            # Create new entity - _create_entity checks unique constraints
            return await self._create_entity(entity, owner, session)

    async def stamp_last_active_at(self, entity_id: str, timestamp_ms: int) -> tuple[DBBaseRecord | None, bool]:
        """Atomically stamp recency without rewriting a stale entity snapshot.

        The writer transaction first hydrates the authoritative row so a stale
        pre-close Tab activation still observes ``visible=False`` and no-ops.
        Otherwise ``json_set`` changes only ``last_active_at`` in one UPDATE
        statement, preserving every other persisted field.
        """
        async with self._session_ctx() as session:
            current_result = await session.execute(select(EntitySchema).where(EntitySchema.id == entity_id))
            schema = current_result.scalar_one_or_none()
            if schema is None:
                return None, False

            current = self._schema_to_entity(schema)
            if current.get_type() == "tab" and getattr(current, "visible", True) is False:
                return current, False

            # Match the audit behavior of the former ``Entity.save()`` path,
            # but derive it from the authoritative row.  In particular,
            # apply_update_fields preserves an existing updated_date (the old
            # save path did not reset it) while updating actor/provenance.
            self.apply_update_fields(current)
            await session.execute(
                update(EntitySchema)
                .where(EntitySchema.id == entity_id)
                .values(
                    updated_by=current.updated_by,
                    updated_date=current.updated_date,
                    updated_through=current.updated_through,
                    data=func.json_set(
                        func.coalesce(EntitySchema.data, "{}"),
                        "$.last_active_at",
                        timestamp_ms,
                    ),
                )
            )
            current.last_active_at = timestamp_ms
            current._dirty = False
            return current, True

    async def _patch_data_field(
        self,
        entity_id: str,
        entity_type: str,
        field_name: str,
        value: object,
        expected_value: object = _UNSET,
    ) -> tuple[DBBaseRecord | None, bool]:
        """Patch one entity-data field without upserting or rewriting stale state.

        The UPDATE itself proves that the row still exists — and, when
        ``expected_value`` is supplied, that the field still carries the value
        the caller inspected. A delayed background callback therefore cannot
        recreate a deleted entity or overwrite a concurrent user edit through
        ``save()``'s intentional upsert path.
        """
        if not field_name or not field_name.replace("_", "").isalnum():
            raise ValueError(f"Invalid entity data field: {field_name!r}")

        entity_type = entity_type.lower()
        json_path = f"$.{field_name}"
        async with self._session_ctx() as session:
            current_result = await session.execute(
                select(EntitySchema).where(
                    EntitySchema.id == entity_id,
                    EntitySchema.type == entity_type,
                )
            )
            schema = current_result.scalar_one_or_none()
            if schema is None:
                return None, False

            current = self._schema_to_entity(schema)
            if field_name not in current.__class__.model_fields:
                raise ValueError(f"Unknown {entity_type} data field: {field_name!r}")

            self.apply_update_fields(current)
            where = [EntitySchema.id == entity_id, EntitySchema.type == entity_type]
            if expected_value is not _UNSET:
                current_value = func.json_extract(func.coalesce(EntitySchema.data, "{}"), json_path)
                where.append(current_value.is_(None) if expected_value is None else current_value == expected_value)
            result = await session.execute(
                update(EntitySchema)
                .where(*where)
                .values(
                    updated_by=current.updated_by,
                    updated_date=current.updated_date,
                    updated_through=current.updated_through,
                    data=func.json_set(
                        func.coalesce(EntitySchema.data, "{}"),
                        json_path,
                        func.json(json.dumps(value, cls=SafeJSONEncoder)),
                    ),
                )
            )
            if not result.rowcount:
                return None, False

            setattr(current, field_name, value)
            current._dirty = False
            return current, True

    async def compare_and_set_data_field(
        self,
        entity_id: str,
        entity_type: str,
        field_name: str,
        expected_value: object,
        value: object,
    ) -> tuple[DBBaseRecord | None, bool]:
        """Patch one field only while it still holds ``expected_value``."""
        return await self._patch_data_field(entity_id, entity_type, field_name, value, expected_value=expected_value)

    async def update_existing_data_field(
        self,
        entity_id: str,
        entity_type: str,
        field_name: str,
        value: object,
    ) -> tuple[DBBaseRecord | None, bool]:
        """Patch one field on an existing row; a missing row stays missing."""
        return await self._patch_data_field(entity_id, entity_type, field_name, value)

    async def _create_entity(self, entity: DBBaseRecord, owner: TypeId | None, session: AsyncSession) -> DBBaseRecord:
        """Create a new entity.

        Uses session.flush() to surface IntegrityError early so the
        type_uname → HTTPException(409) mapping stays local. The outer
        _session_ctx (or request middleware) drives the commit.
        """
        # Check unique constraints (app-level for fields not covered by DB constraints)
        await self._check_unique_constraints(entity, session)

        # Apply creation fields
        self.apply_create_fields(entity)

        # Generate namespace key if needed
        request_info = get_current_request_info()
        if request_info and request_info.namespace:
            entity.key = await self._gen_namespace_key(request_info.namespace, session)

        # Convert to schema
        schema = self._entity_to_schema(entity)
        session.add(schema)
        try:
            await session.flush()
        except Exception as e:
            if "UNIQUE constraint failed" in str(e) and "type_uname" in str(e):
                label = entity.get_type().capitalize()
                raise HTTPException(
                    status_code=409,
                    detail=f"Save error(already exist) - {label}: uname = {entity.uname}",
                ) from e
            raise

        # Create owner relationship
        if owner:
            await self._create_owner_relationship(entity, owner, known_new=True)
        elif entity.get_type() == BuiltinEntityType.USER.value.lower():
            # For users without an explicit owner, create self-loop relationship
            await self._create_owner_relationship(entity, entity.typeid)

        return entity

    async def _update_entity(self, entity: DBBaseRecord, session: AsyncSession) -> DBBaseRecord:
        """Update an existing entity. Outer _session_ctx drives commit."""
        # A row only reaches here after ``save()`` has SELECTed it and confirmed
        # it exists, so a null ``created_by`` is NOT a create-on-existing
        # collision. It is a legitimate hub-origin reflection: the hub stamps no
        # owner (``initiated_by``) for share/diagnostics conversations, so the
        # receiver faithfully reflects ``created_by=None`` — and a later backfill
        # (participants/title/parent) must still be able to UPDATE that row.
        # Rejecting it here aborted invitation-preview + bundle unpack, so the
        # recipient never saw the messages or their attachments. Reject only a
        # structurally malformed entity (the field missing entirely).
        if not hasattr(entity, "created_by"):
            raise HTTPException(status_code=400, detail=f"Entity with ID {entity.id} already exists")

        self.apply_update_fields(entity)

        # Get data dict for dynamic fields
        data_dict = self._get_entity_data_dict(entity)

        entity_type = (entity.type or entity.get_type()).lower()
        try:
            await session.execute(
                update(EntitySchema)
                .where(EntitySchema.id == entity.id)
                .values(
                    type=entity_type,
                    namespace=entity.namespace,
                    key=entity.key,
                    uname=entity.uname,
                    type_uname=self._compute_type_uname(entity_type, entity.uname),
                    created_by=entity.created_by,
                    created_date=entity.created_date,
                    updated_by=entity.updated_by,
                    updated_date=entity.updated_date,
                    created_through=entity.created_through,
                    updated_through=entity.updated_through,
                    data=json.dumps(data_dict, cls=SafeJSONEncoder) if data_dict else None,
                )
            )
            return entity
        except Exception as e:
            logger.error(f"sqllite Error updating entity {entity.id}: {e}")
            raise

    async def _bulk_fetch_existing_ids(self, session, ids: list, batch_size: int) -> set:
        """Return the subset of ``ids`` that already exist in the DB.

        Chunked to stay under SQLite's bind-parameter limit.
        """
        from sqlalchemy import select as _select  # noqa: PLC0415

        existing: set = set()
        for i in range(0, len(ids), batch_size):
            chunk = ids[i : i + batch_size]
            result = await session.execute(_select(EntitySchema.id).where(EntitySchema.id.in_(chunk)))
            existing.update(row[0] for row in result)
        return existing

    async def _bulk_update_entity(self, session, entity) -> None:
        """UPDATE a single entity row inside an open session."""
        self.apply_update_fields(entity)
        data_dict = self._get_entity_data_dict(entity)
        entity_type = (entity.type or entity.get_type()).lower()
        await session.execute(
            update(EntitySchema)
            .where(EntitySchema.id == entity.id)
            .values(
                type=entity_type,
                namespace=entity.namespace,
                key=entity.key,
                uname=entity.uname,
                type_uname=self._compute_type_uname(entity_type, entity.uname),
                created_by=entity.created_by,
                created_date=entity.created_date,
                updated_by=entity.updated_by,
                updated_date=entity.updated_date,
                created_through=entity.created_through,
                updated_through=entity.updated_through,
                data=json.dumps(data_dict, cls=SafeJSONEncoder) if data_dict else None,
            )
        )

    async def bulk_save(self, entities: list, owner=None, batch_size: int = 500) -> None:
        """Save multiple entities in a single transaction.

        Much faster than calling save() per entity because it opens only ONE
        connection and commits once for all entities.

        ``batch_size`` controls the maximum number of IDs per SELECT IN query —
        kept well below SQLite's default bind-parameter limit of 999.
        Duplicates in ``entities`` (same id) are deduplicated — last entry wins.
        """
        if not entities:
            return
        # Deduplicate by id — last write wins (same id from different sources)
        by_id: dict = {}
        for e in entities:
            by_id[e.id] = e
        entities = list(by_id.values())

        async with self._session_ctx() as session:
            existing_ids = await self._bulk_fetch_existing_ids(session, list(by_id.keys()), batch_size)
            for entity in entities:
                if entity.id in existing_ids:
                    await self._bulk_update_entity(session, entity)
                else:
                    self.apply_create_fields(entity)
                    data_dict = self._get_entity_data_dict(entity)
                    entity_type = (entity.type or entity.get_type()).lower()
                    stmt = (
                        sqlite_insert(EntitySchema)
                        .values(
                            id=entity.id,
                            type=entity_type,
                            namespace=entity.namespace,
                            key=entity.key,
                            uname=entity.uname,
                            type_uname=self._compute_type_uname(entity_type, entity.uname),
                            created_by=entity.created_by,
                            created_date=entity.created_date,
                            updated_by=entity.updated_by,
                            updated_date=entity.updated_date,
                            created_through=entity.created_through,
                            updated_through=entity.updated_through,
                            schema_version=entity.schema_version if hasattr(entity, "schema_version") else None,
                            data=json.dumps(data_dict, cls=SafeJSONEncoder) if data_dict else None,
                            record_data_ref=entity.record_data_ref if hasattr(entity, "record_data_ref") else None,
                        )
                        .on_conflict_do_nothing(index_elements=["type_uname"])
                    )
                    await session.execute(stmt)

    async def create(self, entity: DBBaseRecord, owner: TypeId | None = None) -> DBBaseRecord:
        """Create new entity (explicit create)."""
        async with self._session_ctx() as session:
            result = await session.execute(select(EntitySchema).where(EntitySchema.id == entity.id))
            if result.scalar_one_or_none():
                raise HTTPException(status_code=400, detail=f"Entity with ID {entity.id} already exists")
            self.reset_create_fields(entity)
            return await self._create_entity(entity, owner, session)

    async def update(self, entity: DBBaseRecord, updated_by: TypeId | None = None) -> DBBaseRecord:
        """Update existing entity (uses upsert semantics to match NetworkX behavior)."""
        # Preserve any pre-set updated_date (e.g. file mtime from meta_dict) before reset.
        preset_updated_date = entity.updated_date
        self.reset_update_fields(entity)
        if preset_updated_date is not None:
            entity.updated_date = preset_updated_date
        # Use save with upsert semantics - this handles the case where
        # the entity doesn't actually exist yet (e.g., when created_by was set
        # in the constructor but the entity was never persisted)
        return await self.save(entity, None)

    async def delete(self, root_typeid: TypeId) -> List[str]:
        """Delete entity and its descendants."""
        deleted_ids = []
        async with self._session_ctx() as session:
            # Get all descendants
            descendants = await self.get_children_sub_tree(root_typeid, None)
            entity_ids = [desc.id for desc in descendants]
            entity_ids.append(root_typeid.id)

            # Delete relationships first
            for entity_id in entity_ids:
                await session.execute(
                    delete(RelationshipSchema).where(
                        (RelationshipSchema.from_id == entity_id) | (RelationshipSchema.to_id == entity_id)
                    )
                )

            # Delete entities
            for entity_id in entity_ids:
                await session.execute(delete(EntitySchema).where(EntitySchema.id == entity_id))
                deleted_ids.append(entity_id)

        return deleted_ids

    async def delete_by_id(self, eid: str, entity_type: str) -> bool:
        """Delete entity by ID."""
        async with self._session_ctx() as session:
            result = await session.execute(
                select(EntitySchema).where(EntitySchema.id == eid, EntitySchema.type == entity_type)
            )
            if not result.scalar_one_or_none():
                return False

            # Delete relationships
            await session.execute(
                delete(RelationshipSchema).where(
                    (RelationshipSchema.from_id == eid) | (RelationshipSchema.to_id == eid)
                )
            )
            # Delete entity
            await session.execute(delete(EntitySchema).where(EntitySchema.id == eid))
            return True

    # ==================== Entity Queries ====================

    async def get_by_prop(self, property_key: str, property_value: str, entity_type: str) -> Optional[DBBaseRecord]:
        """Get entity by property value."""
        async with self._session_ctx(write=False) as session:
            # Check if property is a direct column (excluding 'data' which is the JSON column)
            if property_key in EntitySchema.__table__.columns and property_key != "data":
                column = getattr(EntitySchema, property_key)
                result = await session.execute(
                    select(EntitySchema).where(column == property_value, EntitySchema.type == entity_type)
                )
            else:
                # Search in JSON data - use json_extract for SQLite
                result = await session.execute(
                    select(EntitySchema).where(
                        EntitySchema.type == entity_type,
                        text(f"json_extract(data, '$.{property_key}') = :value").bindparams(value=property_value),
                    )
                )

            schema = result.scalar_one_or_none()
            if not schema:
                if property_key == "id" and logger.isEnabledFor(logging.DEBUG):
                    by_id_only = await session.execute(
                        select(EntitySchema.id, EntitySchema.type).where(EntitySchema.id == property_value)
                    )
                    rows_for_id = by_id_only.all()
                    by_type_count = await session.execute(
                        select(EntitySchema.id).where(EntitySchema.type == entity_type).limit(3)
                    )
                    sample_ids = [r[0] for r in by_type_count.all()]
                    logger.debug(
                        f"sqlite.get_by_prop miss: query type={entity_type!r} id={property_value!r} → "
                        f"rows_with_this_id_any_type={[(r[0], r[1]) for r in rows_for_id]} "
                        f"sample_ids_for_this_type={sample_ids}"
                    )
                return None
            return self._schema_to_entity(schema)

    async def get_by_id(self, eid: str, entity_type: str) -> Optional[DBBaseRecord]:
        """Get entity by ID."""
        return await self.get_by_prop("id", eid, entity_type)

    async def get_by_namespace(self, namespace: str, entity_type: str) -> Optional[DBBaseRecord]:
        """Get entity by namespace."""
        return await self.get_by_prop("namespace", namespace, entity_type)

    async def get_by_key(self, key: str, entity_type: str) -> Optional[DBBaseRecord]:
        """Get entity by key (case-insensitive)."""
        async with self._session_ctx(write=False) as session:
            result = await session.execute(
                select(EntitySchema).where(
                    EntitySchema.type == entity_type,
                    EntitySchema.key == key.lower(),
                )
            )
            schema = result.scalar_one_or_none()
            if not schema:
                return None
            return self._schema_to_entity(schema)

    async def get_all(self, entities_filter: QueryFilter, source_entity: TypeId | None = None) -> List[DBBaseRecord]:
        """Get all entities matching the filter.

        Translates the QueryFilter match expression into a single SQL WHERE clause so
        SQLite does the filtering — avoiding deserializing every row of a type into
        Python objects before discarding most of them.

        For conditions that cannot be expressed in SQL (PROP references, unsupported ops)
        a Python post-filter is applied on the already-reduced result set.

        ``source_entity`` is *structural scope*, NOT authorization. Local SQLite is a
        single-user store and enforces no per-user authorization (that lives at the hub).
        - ``None`` or a ``user`` source  -> no scope filter (return all rows of the type).
        - a non-user source              -> restrict to descendants of that entity via the
          ``is_child`` role edges, as a single recursive-CTE subquery (no per-row walk).
        """
        counter = [0]  # mutable counter for unique SQL parameter names

        # Base query — always filters by entity type (indexed column)
        query = select(EntitySchema).where(EntitySchema.type == entities_filter.type)

        # Translate match expression to SQL WHERE
        sql_cond, fully_sql = (
            self._expr_to_sql(entities_filter.match, counter) if entities_filter.match else (None, True)
        )
        if sql_cond is not None:
            query = query.where(sql_cond)

        # Structural scope: restrict to descendants of a non-user source (see helper).
        scope_cond = self._scope_descendants_condition(source_entity)
        if scope_cond is not None:
            query = query.where(scope_cond)

        # Push ORDER BY for column-level sort fields
        sql_order, needs_python_sort = self._build_sql_order_by(entities_filter.order_by)
        if sql_order:
            query = query.order_by(*sql_order)

        # Push LIMIT/OFFSET to SQL only when the full filter+sort is handled in SQL
        # (if Python post-filter or Python sort is needed, pagination must happen after).
        can_push_pagination = fully_sql and not needs_python_sort
        if can_push_pagination:
            if entities_filter.offset:
                query = query.offset(entities_filter.offset)
            if entities_filter.limit:
                query = query.limit(entities_filter.limit)

        async with self._session_ctx(write=False) as session:
            result = await session.execute(query)
            entities = [self._schema_to_entity(s) for s in result.scalars().all()]

        # Python post-filter — only needed when SQL pushdown was partial
        if not fully_sql:
            entities = [e for e in entities if self._entity_matches_filter(e, entities_filter)]

        # Python sort — only for sort fields that live in the JSON blob
        if needs_python_sort:
            entities = self._apply_sorting(entities, entities_filter.order_by)

        # Pagination — only when not already applied in SQL
        if not can_push_pagination:
            if entities_filter.offset:
                entities = entities[entities_filter.offset :]
            if entities_filter.limit:
                entities = entities[: entities_filter.limit]

        return entities

    @staticmethod
    def _scope_descendants_condition(source_entity: TypeId | None):
        """SQL condition restricting EntitySchema.id to descendants of ``source_entity``.

        Structural scope only (NOT authorization). Returns None when no scoping applies:
        a ``None`` source or a ``user`` source means "no scope" (single-user local store —
        all rows are the user's). For a non-user source, builds a recursive CTE over the
        ``is_child`` role edges rooted at the source and requires membership in it — one
        SQL statement, instead of a per-row descendant walk.
        """
        if source_entity is None or source_entity.type == "user":
            return None
        # Anchor: direct children of the source via is_child role edges.
        descendants = (
            select(RelationshipSchema.to_id.label("id"))
            .where(
                RelationshipSchema.from_id == source_entity.id,
                RelationshipSchema.type == "role",
                RelationshipSchema.is_child.is_(True),
            )
            .cte("scope_descendants", recursive=True)
        )
        # Recursive step: children of nodes already in the set (transitive descendants).
        descendants = descendants.union_all(
            select(RelationshipSchema.to_id.label("id"))
            .join(descendants, RelationshipSchema.from_id == descendants.c.id)
            .where(
                RelationshipSchema.type == "role",
                RelationshipSchema.is_child.is_(True),
            )
        )
        return EntitySchema.id.in_(select(descendants.c.id))

    def _expr_to_sql(self, expr: ExpressionNode, counter: list) -> tuple:
        """Translate an ExpressionNode into a SQLAlchemy WHERE condition.

        Returns (condition, is_complete) where:
        - condition:    a SQLAlchemy clause element, or None if nothing could be pushed
        - is_complete:  True when the condition fully captures the expression
                        (Python post-filter not needed for correctness)

        AND: pushes all translatable operands; complete only when all operands push.
        OR:  pushes only when every operand is translatable (partial OR changes semantics).
        Leaf: complete when the op+field combination is SQL-expressible.
        """
        if expr.op == QueryOp.AND:
            parts, all_complete = [], True
            for operand in expr.operands:
                if not isinstance(operand, ExpressionNode):
                    all_complete = False
                    continue
                cond, complete = self._expr_to_sql(operand, counter)
                if cond is not None:
                    parts.append(cond)
                if not complete:
                    all_complete = False
            if not parts:
                return None, False
            return and_(*parts), all_complete

        if expr.op == QueryOp.OR:
            parts = []
            for operand in expr.operands:
                if not isinstance(operand, ExpressionNode):
                    return None, False
                cond, complete = self._expr_to_sql(operand, counter)
                if cond is None or not complete:
                    return None, False  # partial OR is semantically unsafe
                parts.append(cond)
            return (or_(*parts), True) if parts else (None, False)

        # Leaf node. The null-test ops are unary — ``operands=[field]`` is the
        # canonical wire shape (a trailing JSON null does not survive axios GET
        # param serialization); a legacy ``[field, None]`` is also accepted.
        if expr.op in (QueryOp.IS_NULL, QueryOp.IS_NOT_NULL):
            if not expr.operands:
                return None, False
            field_name, value = expr.operands[0], None
        elif len(expr.operands) < 2:
            return None, False
        else:
            field_name, value = expr.operands[0], expr.operands[1]

        # PROP references and non-string field names are not SQL-pushable
        if not isinstance(field_name, str) or isinstance(value, ExpressionNode):
            return None, False

        n = counter[0]
        counter[0] += 1

        if field_name in self._COLUMN_FIELDS:
            cond = self._col_op_to_sql(field_name, expr.op, value, n)
        else:
            cond = self._json_op_to_sql(field_name, expr.op, value, n)

        return cond, cond is not None

    def _col_op_to_sql(self, field_name: str, op: QueryOp, value: Any, n: int):
        """Translate a column-level leaf to a SQLAlchemy condition."""
        col = getattr(EntitySchema, field_name, None)
        if col is None:
            return None
        if op == QueryOp.EQ:
            return col == value
        if op == QueryOp.NE:
            return col != value
        if op == QueryOp.GT:
            return col > value
        if op == QueryOp.GE:
            return col >= value
        if op == QueryOp.LT:
            return col < value
        if op == QueryOp.LE:
            return col <= value
        if op == QueryOp.IS_NULL:
            return col.is_(None)
        if op == QueryOp.IS_NOT_NULL:
            return col.is_not(None)
        if op == QueryOp.IN and isinstance(value, list):
            return col.in_(value)
        if op == QueryOp.NIN and isinstance(value, list):
            return col.notin_(value)
        if op == QueryOp.LIKE and isinstance(value, str):
            return col.like(f"%{value}%")
        return None

    def _json_op_to_sql(self, field_name: str, op: QueryOp, value: Any, n: int):
        """Translate a JSON-blob field leaf to a SQLAlchemy text condition."""
        path = f"json_extract(data, '$.{field_name}')"
        pname = f"p{n}"
        # SQLite stores JSON booleans as integers (1/0); convert before binding.
        # String "true"/"false" can arrive from URL query params.
        if isinstance(value, bool):
            sv = 1 if value else 0
        elif isinstance(value, str) and value.lower() in ("true", "false"):
            sv = 1 if value.lower() == "true" else 0
        else:
            sv = str(value) if value is not None else None

        if op == QueryOp.IS_NULL:
            return text(f"{path} IS NULL")
        if op == QueryOp.IS_NOT_NULL:
            return text(f"{path} IS NOT NULL")
        if op == QueryOp.EQ:
            return text(f"{path} = :{pname}").bindparams(**{pname: sv})
        if op == QueryOp.NE:
            return text(f"{path} != :{pname}").bindparams(**{pname: sv})
        if op == QueryOp.GT:
            return text(f"{path} > :{pname}").bindparams(**{pname: sv})
        if op == QueryOp.GE:
            return text(f"{path} >= :{pname}").bindparams(**{pname: sv})
        if op == QueryOp.LT:
            return text(f"{path} < :{pname}").bindparams(**{pname: sv})
        if op == QueryOp.LE:
            return text(f"{path} <= :{pname}").bindparams(**{pname: sv})
        if op == QueryOp.LIKE and isinstance(value, str):
            return text(f"{path} LIKE :{pname}").bindparams(**{pname: f"%{value}%"})
        if op == QueryOp.IN and isinstance(value, list):
            params = {f"{pname}_{i}": str(v) for i, v in enumerate(value)}
            placeholders = ", ".join(f":{pname}_{i}" for i in range(len(value)))
            return text(f"{path} IN ({placeholders})").bindparams(**params)
        if op == QueryOp.NIN and isinstance(value, list):
            params = {f"{pname}_{i}": str(v) for i, v in enumerate(value)}
            placeholders = ", ".join(f":{pname}_{i}" for i in range(len(value)))
            return text(f"{path} NOT IN ({placeholders})").bindparams(**params)
        return None

    def _build_sql_order_by(self, order_by) -> tuple:
        """Return (sql_clauses, needs_python_sort).

        Pushes column-field sorts to SQL ORDER BY; leaves JSON-field sorts for Python.
        If any sort field lives in the JSON blob, needs_python_sort=True and Python
        _apply_sorting() will run on the result (overriding the SQL order).
        """
        if not order_by:
            return [], False

        if isinstance(order_by, dict):
            order_by = [order_by]
        elif isinstance(order_by, str):
            order_by = [{order_by: "asc"}]

        sql_clauses, needs_python = [], False
        for spec in order_by:
            if isinstance(spec, str):
                spec = {spec.lstrip("-"): "desc" if spec.startswith("-") else "asc"}
            if isinstance(spec, dict):
                for field, direction in spec.items():
                    if field in self._COLUMN_FIELDS:
                        col = getattr(EntitySchema, field)
                        sql_clauses.append(desc(col) if direction == "desc" else asc(col))
                    else:
                        needs_python = True
        return sql_clauses, needs_python

    # ==================== Relationship CRUD ====================

    async def save_relationship(
        self, relationship: DBBaseRelationship, create: bool = True, *, known_new: bool = False
    ) -> DBBaseRelationship:
        """Save relationship to database.

        The `create` flag controls which audit fields are applied:
        - True: apply create fields (created_by, created_date, etc.)
        - False: apply update fields only

        The actual save uses upsert semantics to match NetworkX behavior.
        """
        if create:
            self.apply_create_fields(relationship)
        else:
            self.apply_update_fields(relationship)

        async with self._session_ctx() as session:
            schema = self._relationship_to_schema(relationship)

            # ``known_new`` skips this probe for an edge minted alongside a
            # brand-new entity — it cannot pre-exist, so the round-trip could
            # only ever return None. A genuine race still hits the PK on insert.
            existing = None if known_new else await session.get(RelationshipSchema, relationship.id)
            if existing:
                # Update existing relationship
                for key, value in schema.to_dict().items():
                    setattr(existing, key, value)
            else:
                # Insert new relationship
                session.add(schema)
        return relationship

    async def update_relationship(self, relationship: DBBaseRelationship) -> DBBaseRelationship:
        """Update an existing relationship."""
        self.reset_update_fields(relationship)
        return await self.save_relationship(relationship, create=False)

    async def delete_relationship(self, relationship: DBBaseRelationship):
        """Delete a relationship by matching from_id, to_id, and type."""
        async with self._session_ctx() as session:
            from_id = relationship.from_typeid.id if relationship.from_typeid else None
            to_id = relationship.to_typeid.id if relationship.to_typeid else None

            if not from_id or not to_id:
                # Fall back to deletion by ID if from/to not specified
                await session.execute(delete(RelationshipSchema).where(RelationshipSchema.id == relationship.id))
            else:
                # Find matching relationship by from_id, to_id, and type (matching NetworkX behavior)
                query = delete(RelationshipSchema).where(
                    RelationshipSchema.from_id == from_id,
                    RelationshipSchema.to_id == to_id,
                    RelationshipSchema.type == relationship.get_type(),
                )
                await session.execute(query)

    async def create_relationship(self, from_e: TypeId, to_e: TypeId, rel_type: str) -> DBBaseRecord:
        """Create a new relationship."""
        rel_model = self.registry.get(rel_type)
        if not rel_model:
            raise ValueError(f"Unknown relationship type {rel_type}")
        rel = rel_model(from_typeid=from_e, to_typeid=to_e, type=rel_type)
        return await self.save_relationship(rel)

    # ==================== Relationship Queries ====================

    async def get_relationship_by_id(self, rid: str) -> Optional[DBBaseRelationship]:
        """Get relationship by ID."""
        async with self._session_ctx(write=False) as session:
            result = await session.execute(select(RelationshipSchema).where(RelationshipSchema.id == rid))
            schema = result.scalar_one_or_none()
            if not schema:
                return None
            return self._schema_to_relationship(schema)

    async def get_all_relationships(self, relationships_filter: QueryFilter) -> List[DBBaseRelationship]:
        """Get all relationships matching filter."""
        async with self._session_ctx(write=False) as session:
            query = select(RelationshipSchema)
            if relationships_filter.type:
                query = query.where(RelationshipSchema.type == relationships_filter.type)
            result = await session.execute(query)
            relationships = [self._schema_to_relationship(s) for s in result.scalars().all()]

        # Apply match filter
        if relationships_filter.match:
            relationships = [r for r in relationships if self._relationship_matches_filter(r, relationships_filter)]

        return relationships

    async def get_relationships(
        self,
        of_typeid: TypeId,
        relationships_filter: QueryFilter,
        connections_filter: QueryFilter,
        direction: RelationshipDirection = RelationshipDirection.Both,
    ) -> List[DBBaseRelationship]:
        """Get relationships of an entity in specified direction."""
        incoming = []
        outgoing = []

        if direction in [RelationshipDirection.Both, RelationshipDirection.Incoming]:
            incoming = await self.get_incoming_relationships(of_typeid, relationships_filter, connections_filter)

        if direction in [RelationshipDirection.Both, RelationshipDirection.Outgoing]:
            outgoing = await self.get_outgoing_relationships(of_typeid, relationships_filter, connections_filter)

        return incoming + outgoing

    async def get_incoming_relationships(
        self, to_typeid: TypeId, relationships_filter: QueryFilter, from_filter: QueryFilter
    ) -> List[DBBaseRelationship]:
        """Get incoming relationships to an entity."""
        async with self._session_ctx(write=False) as session:
            query = select(RelationshipSchema).where(RelationshipSchema.to_id == to_typeid.id)
            if relationships_filter.type:
                query = query.where(RelationshipSchema.type == relationships_filter.type)
            result = await session.execute(query)
            relationships = [self._schema_to_relationship(s) for s in result.scalars().all()]

        # Apply filters
        filtered = []
        for rel in relationships:
            if relationships_filter.match and not self._relationship_matches_filter(rel, relationships_filter):
                continue
            filtered.append(rel)
        return filtered

    async def get_outgoing_relationships(
        self, from_typeid: TypeId, relationships_filter: QueryFilter, to_filter: QueryFilter
    ) -> List[DBBaseRelationship]:
        """Get outgoing relationships from an entity."""
        async with self._session_ctx(write=False) as session:
            query = select(RelationshipSchema).where(RelationshipSchema.from_id == from_typeid.id)
            if relationships_filter.type:
                query = query.where(RelationshipSchema.type == relationships_filter.type)
            result = await session.execute(query)
            relationships = [self._schema_to_relationship(s) for s in result.scalars().all()]

        # Apply filters
        filtered = []
        for rel in relationships:
            if relationships_filter.match and not self._relationship_matches_filter(rel, relationships_filter):
                continue
            filtered.append(rel)
        return filtered

    # ==================== Path Finding ====================

    async def get_paths(
        self,
        rel_type: str,
        from_typeid: TypeId,
        to_typeid: TypeId,
        is_direct_relationship_only: bool = False,
    ) -> List[NodesPath]:
        """Get all paths between two entities using SQL + Python hybrid approach."""
        # Load role graph into memory
        graph = await self._load_relationship_graph(rel_type)
        paths = []

        # Special case: from and to are the same (self-loop)
        if from_typeid.id == to_typeid.id:
            # Look for self-loop edges
            for edge in graph.get(from_typeid.id, []):
                if edge["to_id"] == from_typeid.id:
                    node_path = await self._build_nodes_path([edge])
                    if node_path:
                        paths.append(node_path)
            return paths

        # Collect self-loops at the start node (for role chain initialization)
        # These need to be prepended to paths to properly initialize role chains
        # e.g., $start_path -> owner
        start_self_loops = []
        for edge in graph.get(from_typeid.id, []):
            if edge["to_id"] == from_typeid.id:
                start_self_loops.append(edge)

        # BFS to find all paths for non-self-loop cases
        queue = [(from_typeid.id, [from_typeid.id], [])]  # (current_id, path_nodes, path_edges)
        visited_paths = set()
        raw_paths = []  # Collect raw edge lists first

        while queue:
            current_id, path_nodes, path_edges = queue.pop(0)

            if current_id == to_typeid.id and path_edges:
                # Found a path (must have at least one edge)
                # Use edge IDs in path_key to distinguish multiple edges between same nodes
                path_key = tuple(e["id"] for e in path_edges)
                if path_key not in visited_paths:
                    visited_paths.add(path_key)
                    raw_paths.append(path_edges)
                continue

            if is_direct_relationship_only and len(path_nodes) > 1:
                continue

            # Explore neighbors
            for edge in graph.get(current_id, []):
                next_id = edge["to_id"]
                if next_id not in path_nodes or next_id == to_typeid.id:  # Allow reaching target even if visited
                    queue.append((next_id, path_nodes + [next_id], path_edges + [edge]))

        # Build final edge lists with self-loop prefix for role chain initialization
        all_edge_lists = []
        for raw_path in raw_paths:
            if start_self_loops:
                # Add paths with self-loop prefix (for role chain initialization)
                for self_loop in start_self_loops:
                    all_edge_lists.append([self_loop] + raw_path)
            else:
                # No self-loop at start, just add the path as-is
                all_edge_lists.append(raw_path)

        # Batch build all paths at once
        paths = await self._build_nodes_paths_batched(all_edge_lists)

        return paths

    async def get_paths_with_filters(
        self,
        from_filter: QueryFilter,
        rel_filter: QueryFilter,
        to_filter: QueryFilter,
        is_direct_relationship_only: bool,
    ) -> List[NodesPath]:
        """Get all paths between entities matching filters."""
        # Get candidate source and target nodes
        from_entities = await self.get_all(from_filter, None)
        to_entities = await self.get_all(to_filter, None)

        all_paths = []
        for from_entity in from_entities:
            for to_entity in to_entities:
                if from_entity.id == to_entity.id:
                    continue
                paths = await self._get_paths_with_rel_filter(
                    rel_filter,
                    from_entity.typeid,
                    to_entity.typeid,
                    is_direct_relationship_only,
                )
                all_paths.extend(paths)

        return all_paths

    async def _get_paths_with_rel_filter(
        self,
        rel_filter: QueryFilter,
        from_typeid: TypeId,
        to_typeid: TypeId,
        is_direct_relationship_only: bool = False,
    ) -> List[NodesPath]:
        """Get paths with relationship filter applied during traversal."""
        # Load role graph into memory with filter
        graph = await self._load_relationship_graph_with_filter(rel_filter)
        paths = []

        # Special case: from and to are the same (self-loop)
        if from_typeid.id == to_typeid.id:
            for edge in graph.get(from_typeid.id, []):
                if edge["to_id"] == from_typeid.id:
                    node_path = await self._build_nodes_path([edge])
                    if node_path:
                        paths.append(node_path)
            return paths

        # BFS to find all paths for non-self-loop cases
        queue = [(from_typeid.id, [from_typeid.id], [])]
        visited_paths = set()

        while queue:
            current_id, path_nodes, path_edges = queue.pop(0)

            if current_id == to_typeid.id and path_edges:
                path_key = tuple(path_nodes)
                if path_key not in visited_paths:
                    visited_paths.add(path_key)
                    node_path = await self._build_nodes_path(path_edges)
                    if node_path:
                        paths.append(node_path)
                continue

            if is_direct_relationship_only and len(path_nodes) > 1:
                continue

            for edge in graph.get(current_id, []):
                next_id = edge["to_id"]
                if next_id not in path_nodes or next_id == to_typeid.id:
                    queue.append((next_id, path_nodes + [next_id], path_edges + [edge]))

        return paths

    async def _load_relationship_graph_with_filter(self, rel_filter: QueryFilter) -> Dict[str, List[dict]]:
        """Load relationships into adjacency list with filter applied."""
        graph = defaultdict(list)
        async with self._session_ctx(write=False) as session:
            query = select(RelationshipSchema)
            if rel_filter.type:
                query = query.where(RelationshipSchema.type == rel_filter.type)
            result = await session.execute(query)
            for rel in result.scalars():
                # Build edge dict for graph traversal
                edge = {
                    "id": rel.id,
                    "from_id": rel.from_id,
                    "to_id": rel.to_id,
                    "to_type": rel.to_type,
                    "from_role": rel.from_role,
                    "to_role": rel.to_role,
                    "is_child": rel.is_child,
                    "is_final": rel.is_final,
                }
                # Check filter match using expression evaluator
                if rel_filter.match:
                    # Use edge dict as attributes for evaluation
                    if not self._evaluate_expression(rel_filter.match, edge):
                        continue
                graph[rel.from_id].append(edge)
        return graph

    # ==================== Children/Tree Operations ====================

    async def get_children(
        self, root: TypeId, relationship_filter: QueryFilter | None = None, child_filter: QueryFilter | None = None
    ) -> List[EntityChild]:
        """Get direct children of an entity."""
        async with self._session_ctx(write=False) as session:
            query = select(RelationshipSchema).where(
                RelationshipSchema.from_id == root.id,
                RelationshipSchema.type == "role",
                RelationshipSchema.is_child == True,  # noqa: E712
            )
            result = await session.execute(query)
            relationships = result.scalars().all()

        children = []
        for rel_schema in relationships:
            # Get child entity
            child_entity = await self.get_by_id(rel_schema.to_id, rel_schema.to_type)
            if not child_entity:
                continue

            # Apply child filter
            if child_filter and not self._entity_matches_filter(child_entity, child_filter):
                continue

            children.append(EntityChild(value=child_entity))

        if child_filter:
            children = self._sort_children(children, child_filter.order_by)
            if child_filter.offset:
                children = children[child_filter.offset :]
            if child_filter.limit is not None:
                children = children[: child_filter.limit]

        return children

    @staticmethod
    def _sort_key(value):
        """Comparable key that never compares a missing value against a real one.

        Used by ``_apply_sorting`` (the Python fallback for JSON-blob sort fields)
        AND by the child ordering that delegates to it — one rule, one place.

        Bucket 0 = missing, so NULLs sort FIRST on ascending — the same place
        SQLite's ``ORDER BY ... ASC`` puts them, so ordering children in Python
        can't disagree with the SQL path.

        Not reusing ``_apply_sorting``: its key is ``getattr(e, f, "") or ""``,
        which coerces a missing value to ``""`` and then raises comparing ``str``
        to ``datetime``. Children are ordered by ``created_date``, so that would
        be a live hazard here. (Consolidating the two sorters is worth doing, but
        it changes a helper shared with the main query path — left alone
        deliberately rather than folded into this change.)
        """
        return (0, "") if value is None else (1, value)

    def _sort_children(self, children: List[EntityChild], order_by) -> List[EntityChild]:
        """Order children by a field on the child entity.

        Delegates to ``_apply_sorting`` — one sorter, one set of NULL semantics
        (missing values first on asc, matching SQLite's ``ORDER BY``). Children
        arrive wrapped in ``EntityChild``, so values are unwrapped for the sort
        and re-wrapped after.

        The ``id`` pre-sort is the only addition: Python's sort is stable, so
        seeding a deterministic order makes exact-timestamp collisions come back
        identically on every run instead of following relationship-row order.
        """
        if not order_by or not children:
            return children
        values = [c.value for c in children]
        values.sort(key=lambda v: getattr(v, "id", "") or "")
        return [EntityChild(value=v) for v in self._apply_sorting(values, order_by)]

    async def get_children_sub_tree(
        self, root: TypeId, children_filter: QueryFilter | None = None, depth: int | None = None
    ) -> List[DBBaseRecord]:
        """Get all descendants in subtree via BFS."""
        result = []
        visited = set()
        queue = [(root.id, 0)]

        while queue:
            current_id, current_depth = queue.pop(0)
            if current_id in visited:
                continue
            if depth is not None and current_depth >= depth:
                continue

            visited.add(current_id)

            # Get children
            async with self._session_ctx(write=False) as session:
                query = select(RelationshipSchema).where(
                    RelationshipSchema.from_id == current_id,
                    RelationshipSchema.type == "role",
                    RelationshipSchema.is_child == True,  # noqa: E712
                )
                rel_result = await session.execute(query)
                child_rels = rel_result.scalars().all()

            for rel in child_rels:
                if rel.to_id in visited:
                    continue

                # Get child entity
                child_entity = await self.get_by_id(rel.to_id, rel.to_type)
                if not child_entity:
                    continue

                # Check filter
                if children_filter is None or self._entity_matches_filter(child_entity, children_filter):
                    result.append(child_entity)

                # Add to queue for further traversal
                queue.append((rel.to_id, current_depth + 1))

        return result

    async def get_ancestor(self, type_id: TypeId, ancestor_type: str | None = None) -> Optional[DBBaseRecord]:
        """Find ancestor of entity by traversing parent relationships."""
        visited = set()
        queue = [type_id.id]

        while queue:
            current_id = queue.pop(0)
            if current_id in visited:
                continue
            visited.add(current_id)

            # Get parent relationships (incoming role relationships with is_child=True)
            async with self._session_ctx(write=False) as session:
                query = select(RelationshipSchema).where(
                    RelationshipSchema.to_id == current_id,
                    RelationshipSchema.type == "role",
                    RelationshipSchema.is_child == True,  # noqa: E712
                )
                result = await session.execute(query)
                parent_rels = result.scalars().all()

            for rel in parent_rels:
                parent_id = rel.from_id
                if parent_id in visited:
                    continue

                # Get parent entity
                parent_entity = await self.get_by_id(parent_id, rel.from_type)
                if parent_entity:
                    if ancestor_type is None or parent_entity.get_type() == ancestor_type:
                        return parent_entity
                    queue.append(parent_id)

        return None

    # ==================== Other Operations ====================

    async def get_peers(
        self,
        e: TypeId,
        rel_type: str | None = None,
        direction: str | None = None,
        peer_type: str | None = None,
    ) -> List[DBBaseRecord]:
        """Get peer entities connected via relationships."""
        peers = []
        peer_ids = set()

        async with self._session_ctx(write=False) as session:
            # Outgoing
            if direction in [None, "outgoing", "both"]:
                query = select(RelationshipSchema).where(RelationshipSchema.from_id == e.id)
                if rel_type:
                    query = query.where(RelationshipSchema.type == rel_type)
                result = await session.execute(query)
                for rel in result.scalars():
                    peer_ids.add((rel.to_id, rel.to_type))

            # Incoming
            if direction in [None, "incoming", "both"]:
                query = select(RelationshipSchema).where(RelationshipSchema.to_id == e.id)
                if rel_type:
                    query = query.where(RelationshipSchema.type == rel_type)
                result = await session.execute(query)
                for rel in result.scalars():
                    peer_ids.add((rel.from_id, rel.from_type))

        for peer_id, peer_type_val in peer_ids:
            if peer_type and peer_type_val != peer_type:
                continue
            entity = await self.get_by_id(peer_id, peer_type_val)
            if entity:
                peers.append(entity)

        return peers

    async def get_joint_resource(
        self, e1: TypeId, e2: TypeId, joint_resource_filter: QueryFilter
    ) -> Optional[DBBaseRecord]:
        """Find common resource between two entities."""
        # Get reachable nodes from both entities
        nodes1 = await self._get_reachable_nodes(e1.id)
        nodes2 = await self._get_reachable_nodes(e2.id)

        common = nodes1.intersection(nodes2)
        for node_id in common:
            # Get entity and check filter
            async with self._session_ctx(write=False) as session:
                result = await session.execute(select(EntitySchema).where(EntitySchema.id == node_id))
                schema = result.scalar_one_or_none()
                if schema:
                    entity = self._schema_to_entity(schema)
                    if self._entity_matches_filter(entity, joint_resource_filter):
                        return entity
        return None

    async def clean_all_db(self, reset_profile: DBResetProfile | None = None):
        """Clean database with optional selective reset."""
        async with self._session_ctx() as session:
            if reset_profile is None:
                # Full reset
                await session.execute(delete(RelationshipSchema))
                await session.execute(delete(EntitySchema))
            else:
                # Get entities to delete
                result = await session.execute(select(EntitySchema))
                for schema in result.scalars():
                    # Check if should keep
                    if schema.type in reset_profile.types_to_keep:
                        continue
                    type_id = TypeId(type=schema.type, id=schema.id)
                    if type_id in reset_profile.instances_to_keep:
                        continue

                    # Delete relationships
                    await session.execute(
                        delete(RelationshipSchema).where(
                            (RelationshipSchema.from_id == schema.id) | (RelationshipSchema.to_id == schema.id)
                        )
                    )
                    # Delete entity
                    await session.execute(delete(EntitySchema).where(EntitySchema.id == schema.id))

            self.initialized_types.clear()

            # Handle post-reset operations
            if reset_profile and reset_profile.create_builtin_instances:
                # TODO: create_builtin_instances not available locally
                pass
                # await create_builtin_instances()

    # ==================== Helper Methods ====================

    async def _create_owner_relationship(self, entity: DBBaseRecord, owner: TypeId, *, known_new: bool = False):
        """Create owner role relationship."""
        from flow_sdk.db.rolerelationship import RoleRelationship

        is_self_loop = owner.type == BuiltinEntityType.USER.value.lower() and owner.id == entity.id
        from_role = "$start_path" if is_self_loop else "*"

        role_rel = RoleRelationship(from_typeid=owner, to_typeid=entity.typeid)
        role_rel.set_mapping(from_role, "owner")
        role_rel.is_child = True
        return await self.save_relationship(role_rel, known_new=known_new)

    async def _find_by_unique_fields(self, entity: DBBaseRecord, session: AsyncSession) -> Optional[EntitySchema]:
        """Find existing entity with same unique field values."""
        for field in entity.unique_fields():
            field_value = getattr(entity, field, None)
            if field_value is None:
                continue

            # Check standard columns (including uname which has a dedicated column)
            if field in ["id", "namespace", "key", "uname"]:
                column = getattr(EntitySchema, field)
                result = await session.execute(
                    select(EntitySchema).where(
                        column == field_value,
                        EntitySchema.type == entity.get_type(),
                    )
                )
            else:
                # Check in JSON data (for custom unique fields on subclasses)
                result = await session.execute(
                    select(EntitySchema).where(
                        EntitySchema.type == entity.get_type(),
                        text(f"json_extract(data, '$.{field}') = :value").bindparams(value=str(field_value)),
                    )
                )

            existing = result.scalar_one_or_none()
            if existing:
                return existing
        return None

    async def _check_unique_constraints(self, entity: DBBaseRecord, session: AsyncSession):
        """Check unique field constraints.

        Note: 'uname' uniqueness is enforced at the DB level via the type_uname
        unique column (computed as 'type:uname'). This method only checks fields
        that are NOT covered by DB-level constraints (id, namespace, key, and any
        custom unique fields stored in JSON data).
        """
        for field in entity.unique_fields():
            # uname is enforced by the type_uname unique column — skip app-level check
            if field == "uname":
                continue
            # ``id`` is the PRIMARY KEY: the DB enforces it, and the query below
            # would be ``id = <entity.id> AND id != <entity.id>`` — structurally
            # unsatisfiable, so it could only ever return zero rows. It cost a
            # full round-trip per save to prove nothing.
            if field == "id":
                continue

            field_value = getattr(entity, field, None)
            if field_value is None:
                continue

            # Check standard columns
            if field in ["id", "namespace", "key"]:
                column = getattr(EntitySchema, field)
                result = await session.execute(
                    select(EntitySchema).where(
                        column == field_value,
                        EntitySchema.type == entity.get_type(),
                        EntitySchema.id != entity.id,
                    )
                )
            else:
                # Check in JSON data (for custom unique fields on subclasses)
                result = await session.execute(
                    select(EntitySchema).where(
                        EntitySchema.type == entity.get_type(),
                        EntitySchema.id != entity.id,
                        text(f"json_extract(data, '$.{field}') = :value").bindparams(value=str(field_value)),
                    )
                )

            if result.scalar_one_or_none():
                label = entity.get_type().capitalize()
                raise HTTPException(
                    status_code=409, detail=f"Save error(already exist) - {label}: {field} = {field_value}"
                )

    async def _gen_namespace_key(self, namespace: str, session: AsyncSession) -> str:
        """Generate unique key within namespace."""
        from flow_sdk.api.api_types.identifier import get_namespace_key

        namespace = namespace.lower()

        # Find namespace entity and increment counter
        result = await session.execute(select(EntitySchema).where(EntitySchema.namespace == namespace))
        entity_schema = result.scalar_one_or_none()
        if not entity_schema:
            raise ValueError(f"Namespace {namespace} not found")

        # Get current count from data
        data = json.loads(entity_schema.data) if entity_schema.data else {}
        current_count = data.get("eventCount", 0)
        new_count = current_count + 1
        data["eventCount"] = new_count

        # Update
        await session.execute(
            update(EntitySchema)
            .where(EntitySchema.id == entity_schema.id)
            .values(data=json.dumps(data, cls=SafeJSONEncoder))
        )

        return get_namespace_key(namespace, new_count)

    async def _load_relationship_graph(self, rel_type: str) -> Dict[str, List[dict]]:
        """Load relationships into adjacency list."""
        graph = defaultdict(list)
        async with self._session_ctx(write=False) as session:
            result = await session.execute(select(RelationshipSchema).where(RelationshipSchema.type == rel_type))
            for rel in result.scalars():
                graph[rel.from_id].append(
                    {
                        "id": rel.id,
                        "from_id": rel.from_id,
                        "to_id": rel.to_id,
                        "to_type": rel.to_type,
                        "from_role": rel.from_role,
                        "to_role": rel.to_role,
                        "is_child": rel.is_child,
                        "is_final": rel.is_final,
                    }
                )
        return graph

    async def _build_nodes_paths_batched(self, all_edge_lists: List[List[dict]]) -> List[NodesPath]:
        """Build multiple NodesPath objects from edge lists using batched queries."""
        if not all_edge_lists:
            return []

        # Collect all relationship IDs from edges
        all_rel_ids = set()
        for edges in all_edge_lists:
            for edge in edges:
                all_rel_ids.add(edge["id"])

        if not all_rel_ids:
            return []

        # Batch load ALL relationships in one query
        rels_by_id = {}
        async with self._session_ctx(write=False) as session:
            result = await session.execute(select(RelationshipSchema).where(RelationshipSchema.id.in_(all_rel_ids)))
            for schema in result.scalars():
                rel = self._schema_to_relationship(schema)
                rels_by_id[schema.id] = rel

        # Collect entity IDs from the loaded relationships (not from edges, since edges may not have from_id)
        all_entity_ids = set()
        for rel in rels_by_id.values():
            if rel.from_typeid:
                all_entity_ids.add(rel.from_typeid.id)
            if rel.to_typeid:
                all_entity_ids.add(rel.to_typeid.id)

        # Batch load ALL entities in one query
        entities_by_id = {}
        if all_entity_ids:
            async with self._session_ctx(write=False) as session:
                result = await session.execute(select(EntitySchema).where(EntitySchema.id.in_(all_entity_ids)))
                for schema in result.scalars():
                    entity = self._schema_to_entity(schema)
                    entities_by_id[schema.id] = entity

        # Build all paths from cached data
        paths = []
        for edges in all_edge_lists:
            connections = []
            for edge in edges:
                rel = rels_by_id.get(edge["id"])
                if not rel:
                    continue

                source = entities_by_id.get(rel.from_typeid.id if rel.from_typeid else None)
                target = entities_by_id.get(rel.to_typeid.id if rel.to_typeid else None)

                if source and target:
                    connections.append(NodeConnection(source=source, rel=rel, target=target))

            if connections:
                paths.append(NodesPath(connections=connections))

        return paths

    async def _build_nodes_path(self, edges: List[dict]) -> Optional[NodesPath]:
        """Build NodesPath from edge list (delegates to batched version)."""
        if not edges:
            return None
        paths = await self._build_nodes_paths_batched([edges])
        return paths[0] if paths else None

    async def _get_reachable_nodes(self, start_id: str, max_depth: int = 10) -> Set[str]:
        """Get all nodes reachable through role relationships."""
        visited = set()
        queue = [(start_id, 0)]

        while queue:
            current_id, depth = queue.pop(0)
            if current_id in visited or depth > max_depth:
                continue
            visited.add(current_id)

            async with self._session_ctx(write=False) as session:
                result = await session.execute(
                    select(RelationshipSchema).where(
                        RelationshipSchema.from_id == current_id, RelationshipSchema.type == "role"
                    )
                )
                for rel in result.scalars():
                    queue.append((rel.to_id, depth + 1))

        return visited

    @staticmethod
    def _compute_type_uname(entity_type: str, uname: str | None) -> str | None:
        """Compute composite type_uname key for DB unique constraint.

        Returns 'type:uname' when uname is set, None otherwise.
        NULL values in unique columns are treated as distinct by SQLite,
        so entities without a uname won't conflict.
        """
        return f"{entity_type}:{uname}" if uname else None

    def _entity_to_schema(self, entity: DBBaseRecord) -> EntitySchema:
        """Convert entity to schema."""
        # Use the instance's type attribute when explicitly set (e.g. Entity(type="skill", ...)).
        # Fall back to get_type() only when the instance type is empty — this handles subclasses
        # that rely on the class-level default (e.g. Bookmark where type defaults to "bookmark").
        # Always lowercase: get_type() returns lowercase and queries use get_type(), so
        # the stored type must match. Mixed-case defaults (e.g. APIField(default="QueryEntity"))
        # would cause case-mismatch on SELECT otherwise.
        entity_type = (entity.type or entity.get_type()).lower()
        data_dict = self._get_entity_data_dict(entity)
        return EntitySchema(
            id=entity.id,
            type=entity_type,
            namespace=entity.namespace,
            key=entity.key,
            uname=entity.uname,
            type_uname=self._compute_type_uname(entity_type, entity.uname),
            created_by=entity.created_by,
            created_date=entity.created_date,
            updated_by=entity.updated_by,
            updated_date=entity.updated_date,
            created_through=entity.created_through,
            updated_through=entity.updated_through,
            data=json.dumps(data_dict, cls=SafeJSONEncoder) if data_dict else None,
        )

    def _get_entity_data_dict(self, entity: DBBaseRecord) -> dict:
        """Get dynamic fields as dict, excluding blob fields and db_excluded fields.

        Blob fields are stored separately in blob storage, not in the entity's
        data column. This ensures blob fields are only loaded when explicitly
        expanded via expand_blobs().

        Fields marked with ``db_exclude=True`` (via `NoDBAPIField` / `NoDbBField`)
        are runtime-only state (e.g. ``expand``) and must not be persisted —
        otherwise two identical writes can produce different stored JSON if one
        path happens to have triggered an expansion helper. Uses the
        ``DBBaseRecord.is_db_excluded`` classmethod so inherited
        ``db_exclude=True`` flags are honored across the MRO.
        """
        # Which fields persist into the ``data`` JSON is a pure function of the
        # CLASS (model_fields, blob flags, db_exclude across the MRO), but this
        # rebuilt two sets and re-walked the MRO per field on EVERY save.
        cls = entity.__class__
        persist_fields = _PERSIST_FIELDS_CACHE.get(cls)
        if persist_fields is None:
            base_fields = set(DBBaseRecord.model_fields.keys())
            blob_fields = set(cls.get_blob_fields_names())
            persist_fields = tuple(
                n for n in cls.model_fields
                if n not in base_fields and n not in blob_fields and not cls.is_db_excluded(n)
            )
            _PERSIST_FIELDS_CACHE[cls] = persist_fields
        data = {}
        for field_name in persist_fields:
            value = getattr(entity, field_name, None)
            if value is not None:
                serialized = self._serialize_value(value)
                if serialized is not None:
                    data[field_name] = serialized
        return data

    def _serialize_value(self, value: Any) -> Any:
        """Serialize a value to JSON-compatible format."""
        import re
        from enum import Enum

        if value is None:
            return None
        # Handle enums - use .value to get the underlying value
        if isinstance(value, Enum):
            return value.value
        # Skip non-serializable types
        if hasattr(value, "__call__") or hasattr(value, "routes"):  # Skip functions/FastAPI apps
            return None
        # Skip compiled regex patterns
        if isinstance(value, re.Pattern):
            return value.pattern  # Store just the pattern string
        # Handle TypeId - serialize to its string representation
        from flow_sdk.fs_store.type_id import TypeId as _TypeId

        if isinstance(value, _TypeId):
            return str(value)
        # Handle Pydantic models - use mode='json' to serialize enums properly
        if hasattr(value, "model_dump"):
            try:
                return value.model_dump(mode="json")
            except Exception:
                return None
        # Handle lists
        if isinstance(value, list):
            result = []
            for v in value:
                serialized = self._serialize_value(v)
                if serialized is not None:
                    result.append(serialized)
            return result
        # Handle dicts
        if isinstance(value, dict):
            result = {}
            for k, v in value.items():
                serialized = self._serialize_value(v)
                if serialized is not None:
                    result[k] = serialized
            return result
        # Handle datetime
        if hasattr(value, "isoformat"):
            return value.isoformat()
        # Handle primitive types
        if isinstance(value, (str, int, float, bool)):
            return value
        # Try to convert to string as fallback
        try:
            json.dumps(value)
            return value
        except (TypeError, ValueError):
            return None

    def _ensure_utc(self, dt: datetime | str | None) -> datetime | None:
        """Ensure datetime has UTC timezone info.

        Accepts strings because raw ``text()`` SQL results return dates as ISO-8601
        strings rather than ``datetime`` objects (no SQLAlchemy type coercion).
        """
        if dt is None:
            return None
        if isinstance(dt, str):
            try:
                dt = datetime.fromisoformat(dt)
            except ValueError:
                return None
        if dt.tzinfo is None:
            return dt.replace(tzinfo=UTC)
        return dt

    def _schema_to_entity(self, schema: EntitySchema) -> DBBaseRecord:
        """Convert schema to entity."""
        entity_class = self.registry.get(schema.type)
        if not entity_class:
            # Fall back to the base Entity class; avoids hard failure for types registered
            # after the driver was initialised (e.g. plugin types, "entity" base class).
            from flow_sdk.core.entity.entity_model import Entity

            entity_class = Entity

        # Combine base fields and data
        data = json.loads(schema.data) if schema.data else {}
        combined = {
            "id": schema.id,
            "type": schema.type,
            "namespace": schema.namespace,
            "key": schema.key,
            "uname": schema.uname,
            "created_by": schema.created_by,
            "created_date": self._ensure_utc(schema.created_date),
            "updated_by": schema.updated_by,
            "updated_date": self._ensure_utc(schema.updated_date),
            "created_through": schema.created_through,
            "updated_through": schema.updated_through,
            **data,
        }
        return entity_class(**combined)

    def _relationship_to_schema(self, rel: DBBaseRelationship) -> RelationshipSchema:
        """Convert relationship to schema."""
        # Get extra data
        # Same per-class derivation, and same reason, as _get_entity_data_dict.
        rcls = rel.__class__
        extra_fields = _REL_PERSIST_FIELDS_CACHE.get(rcls)
        if extra_fields is None:
            base_fields = set(DBBaseRelationship.model_fields.keys()) | {
                "from_role", "to_role", "is_child", "is_final",
            }
            extra_fields = tuple(n for n in rcls.model_fields if n not in base_fields)
            _REL_PERSIST_FIELDS_CACHE[rcls] = extra_fields
        data = {}
        for field_name in extra_fields:
            value = getattr(rel, field_name, None)
            if value is not None:
                data[field_name] = value.model_dump() if hasattr(value, "model_dump") else value

        # Use instance's type attribute instead of get_type() classmethod
        # This is important for generic Relationship objects with dynamic types
        rel_type = getattr(rel, "type", None) or rel.get_type()

        return RelationshipSchema(
            id=rel.id,
            type=rel_type,
            from_id=rel.from_typeid.id,
            from_type=rel.from_typeid.type,
            to_id=rel.to_typeid.id,
            to_type=rel.to_typeid.type,
            created_by=rel.created_by,
            created_date=rel.created_date,
            updated_by=rel.updated_by,
            updated_date=rel.updated_date,
            from_role=getattr(rel, "from_role", None),
            to_role=getattr(rel, "to_role", None),
            is_child=getattr(rel, "is_child", False),
            is_final=getattr(rel, "is_final", False),
            data=json.dumps(data, cls=SafeJSONEncoder) if data else None,
        )

    def _schema_to_relationship(self, schema: RelationshipSchema) -> DBBaseRelationship:
        """Convert schema to relationship."""
        rel_class = self.registry.get(schema.type)
        if not rel_class:
            # Fallback to base relationship
            from flow_sdk.db.db_relationship import DBRelationship

            rel_class = DBRelationship

        data = json.loads(schema.data) if schema.data else {}
        combined = {
            "id": schema.id,
            "type": schema.type,
            "from_typeid": TypeId(type=schema.from_type, id=schema.from_id),
            "to_typeid": TypeId(type=schema.to_type, id=schema.to_id),
            "created_by": schema.created_by,
            "created_date": self._ensure_utc(schema.created_date),
            "updated_by": schema.updated_by,
            "updated_date": self._ensure_utc(schema.updated_date),
            "from_role": schema.from_role,
            "to_role": schema.to_role,
            "is_child": schema.is_child,
            "is_final": schema.is_final,
            **data,
        }
        return rel_class(**combined)

    def _entity_matches_filter(self, entity: DBBaseRecord, filter: QueryFilter) -> bool:
        """Check if entity matches query filter."""
        if filter.type and entity.get_type() != filter.type:
            return False
        if filter.match:
            # Use model_dump with full serialization to get all fields
            # model_dump() may exclude subclass fields, so we need to get them directly
            attrs = self._get_all_entity_attrs(entity)
            return self._evaluate_expression(filter.match, attrs)
        return True

    def _get_all_entity_attrs(self, entity: DBBaseRecord) -> dict:
        """Get all entity attributes including subclass fields for filtering."""
        # Start with base model_dump()
        attrs = entity.model_dump()
        # Add all model_fields that might not be in model_dump
        for field_name in entity.__class__.model_fields:
            if field_name not in attrs:
                value = getattr(entity, field_name, None)
                if value is not None:
                    attrs[field_name] = value
        return attrs

    def _relationship_matches_filter(self, rel: DBBaseRelationship, filter: QueryFilter) -> bool:
        """Check if relationship matches filter."""
        if filter.type and rel.get_type() != filter.type:
            return False
        if filter.match:
            attrs = rel.model_dump()
            return self._evaluate_expression(filter.match, attrs)
        return True

    def _evaluate_expression(self, expression: ExpressionNode, attributes: Dict[str, Any]) -> bool:
        """Evaluate query expression against attributes."""
        if expression.op == QueryOp.AND:
            return all(
                self._evaluate_expression(op, attributes) if isinstance(op, ExpressionNode) else False
                for op in expression.operands
            )
        elif expression.op == QueryOp.OR:
            return any(
                self._evaluate_expression(op, attributes) if isinstance(op, ExpressionNode) else False
                for op in expression.operands
            )

        # Null-test ops are unary: [field] is canonical, [field, None] accepted.
        if expression.op in (QueryOp.IS_NULL, QueryOp.IS_NOT_NULL):
            if not expression.operands:
                return False
            attr_value = attributes.get(expression.operands[0])
            return attr_value is None if expression.op == QueryOp.IS_NULL else attr_value is not None

        if len(expression.operands) < 2:
            return False

        operand1 = expression.operands[0]
        operand2 = expression.operands[1]

        # Handle PROP expression
        if isinstance(operand2, ExpressionNode) and operand2.op == QueryOp.PROP:
            prop_name = operand2.operands[0]
            prop_value = attributes.get(prop_name)
            if prop_value is None:
                return False
            if expression.op == QueryOp.IN:
                return operand1 in prop_value if isinstance(prop_value, (list, tuple, set)) else False
            elif expression.op == QueryOp.NIN:
                return operand1 not in prop_value if isinstance(prop_value, (list, tuple, set)) else True
            return False

        attr_name = operand1
        target_value = operand2
        attr_value = attributes.get(attr_name)

        if attr_value is None:
            if attr_name in ["is_child", "is_final"] and isinstance(target_value, bool):
                attr_value = False
            else:
                return False

        # Type coercion for datetime comparisons
        # If attr_value is a datetime and target_value is a string, parse the string
        if isinstance(attr_value, datetime) and isinstance(target_value, str):
            try:
                target_value = datetime.fromisoformat(target_value.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                return False

        # Type coercion for boolean comparisons
        # URL query params arrive as strings "true"/"false"; coerce to match bool entity fields
        if isinstance(attr_value, bool) and isinstance(target_value, str):
            if target_value.lower() == "true":
                target_value = True
            elif target_value.lower() == "false":
                target_value = False

        if expression.op == QueryOp.EQ:
            return attr_value == target_value
        elif expression.op == QueryOp.NE:
            return attr_value != target_value
        elif expression.op == QueryOp.GT:
            return attr_value > target_value
        elif expression.op == QueryOp.GE:
            return attr_value >= target_value
        elif expression.op == QueryOp.LT:
            return attr_value < target_value
        elif expression.op == QueryOp.LE:
            return attr_value <= target_value
        elif expression.op == QueryOp.IN:
            return attr_value in target_value if isinstance(target_value, (list, tuple, set)) else False
        elif expression.op == QueryOp.NIN:
            return attr_value not in target_value if isinstance(target_value, (list, tuple, set)) else True
        elif expression.op == QueryOp.LIKE:
            return str(target_value).lower() in str(attr_value).lower()

        return False

    def _apply_sorting(self, entities: List[DBBaseRecord], order_by) -> List[DBBaseRecord]:
        """Apply sorting to entity list."""
        if not order_by or not entities:
            return entities

        if isinstance(order_by, dict):
            order_by = [order_by]
        elif isinstance(order_by, str):
            order_by = [{order_by: "asc"}]

        for sort_spec in reversed(order_by):
            if isinstance(sort_spec, dict):
                for field, direction in sort_spec.items():
                    reverse = direction == "desc"
                    entities.sort(key=lambda e, f=field: self._sort_key(getattr(e, f, None)), reverse=reverse)
            elif isinstance(sort_spec, str):
                if sort_spec.startswith("-"):
                    field = sort_spec[1:]
                    reverse = True
                else:
                    field = sort_spec
                    reverse = False
                entities.sort(key=lambda e, f=field: self._sort_key(getattr(e, f, None)), reverse=reverse)

        return entities

    # ==================== Index Operations (No-op for SQLite) ====================

    async def create_entity_fulltext_index(self, entity_type: str, fulltext_field: str):
        pass

    async def drop_entity_fulltext_index(self, entity_type: str, fulltext_field: str):
        pass

    async def query_entity_fulltext_index(
        self,
        query_string: str,
        num_of_results: int,
        entity_type: str,
        fulltext_field: str,
        entities_filter: QueryFilter,
        source_entity: TypeId | None = None,
    ):
        return []

    async def create_entity_vector_index(self, entity_type: str, vector_field: str):
        pass

    async def drop_entity_vector_index(self, entity_type: str, vector_field: str):
        pass

    async def query_entity_vector_index(
        self,
        query: str,
        num_of_results: int,
        entity_type: str,
        vector_field: str,
        entities_filter: QueryFilter,
        source_entity: TypeId | None = None,
    ) -> Tuple[List[DBBaseRecord], List[float]]:
        return [], []

    async def create_relationship_fulltext_index(self, relationship_type: str, fulltext_field: str):
        pass

    async def drop_relationship_fulltext_index(self, relationship_type: str, fulltext_field: str):
        pass

    async def query_relationship_fulltext_index(
        self,
        query: str,
        num_of_results: int,
        relationship_type: str,
        fulltext_field: str,
        relationships_filter: QueryFilter,
    ):
        return []

    async def create_relationship_vector_index(self, relationship_type: str, vector_field: str):
        pass

    async def drop_relationship_vector_index(self, relationship_type: str, vector_field: str):
        pass

    async def query_relationship_vector_index(
        self,
        query: str,
        num_of_results: int,
        relationship_type: str,
        vector_field: str,
        relationships_filter: QueryFilter,
    ) -> Tuple[List[DBBaseRecord], List[float]]:
        return [], []
