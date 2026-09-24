"""SQLite connection and schema definitions for async SQLAlchemy."""

import asyncio
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Literal
from urllib.parse import quote as _urlquote

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String, Text, event, text
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.orm import DeclarativeBase

from flow_sdk import toplog

logger = logging.getLogger(__name__)


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


# Execution-option key marking connections that belong to the WRITE session
# path. Absent (default) → writer semantics (BEGIN IMMEDIATE). The driver's
# reader session factory derives its engine via
# ``engine.execution_options(**{FLOW_WRITER_OPT: False})`` so read-only driver
# methods skip the writer lock entirely — see ``_on_begin`` below.
FLOW_WRITER_OPT = "flow_writer"


# Writers of THIS process currently blocked in BEGIN IMMEDIATE. SQLite's busy
# handler is not a queue: a blocked writer sleeps up to 100ms between retries,
# so a long-running writer that commits and immediately begins again (the
# indexer, one batch after another) re-takes the lock inside every release
# window and the waiter misses release after release until busy_timeout
# expires — "database is locked" on a user's save while an index runs. The
# count lets such a writer see that someone is queued and hand the lock over
# (``yield_to_waiting_writers``) instead of racing them for it.
_writers_waiting = 0
_handoff_parked: list[asyncio.Future] = []
#: Writers arrive from more than one thread — a request on the server loop, and
#: work that runs its own loop in a thread — so the count and the parked list
#: change under one lock, and a parked task is woken through ITS loop.
_handoff_lock = threading.Lock()


def writers_waiting() -> int:
    """How many writers of this process are blocked acquiring the writer lock."""
    return _writers_waiting


async def yield_to_waiting_writers() -> None:
    """Park until the NEXT blocked writer has been served — acquired the lock or
    given up — then return.

    Once per call, never "until nobody waits": a steady stream of writers would
    otherwise park the caller forever. A caller that checks before each unit of
    work (the indexer, per record) therefore lets each queued writer in at most
    one unit late. Call it only while holding NO write transaction — commit
    first — or the writers it waits for are waiting on the caller.
    """
    with _handoff_lock:
        if not _writers_waiting:
            return
        parked = asyncio.get_running_loop().create_future()
        _handoff_parked.append(parked)
    await parked


def _writer_served() -> None:
    """One blocked writer is done waiting: wake whoever handed the lock over."""
    global _writers_waiting
    with _handoff_lock:
        _writers_waiting -= 1
        parked = _handoff_parked[:]
        _handoff_parked.clear()
    for fut in parked:
        loop = fut.get_loop()
        # Woken through its own loop: this may be another thread. A loop torn
        # down (a test's) has no one left to wake.
        if not loop.is_closed():
            loop.call_soon_threadsafe(_release_parked, fut)


def _release_parked(fut: asyncio.Future) -> None:
    if not fut.done():
        fut.set_result(None)


def _begin_immediate(conn) -> None:
    global _writers_waiting
    with _handoff_lock:
        _writers_waiting += 1
    try:
        conn.exec_driver_sql("BEGIN IMMEDIATE")
    finally:
        _writer_served()


def _release_handle(handle: sqlite3.Connection) -> None:
    """Close a sqlite handle, ending its transaction first.

    ``close()`` alone does not release a transaction while a cursor still holds
    a statement: sqlite defers the whole close, and the handle keeps its
    transaction and the writer lock until that statement is finalized. An
    explicit rollback ends the transaction either way.
    """
    try:
        if handle.in_transaction:
            handle.rollback()
    except sqlite3.Error:
        logger.warning("sqlite: rollback before close failed", exc_info=True)
    finally:
        handle.close()


def _detach_and_release(conn, handle: sqlite3.Connection | None) -> None:
    """Detach ``conn`` from its handle first, so a later ``close()``/``stop()``
    on it returns at once instead of queueing to a worker that is going away."""
    conn._connection = None
    if handle is not None:
        _release_handle(handle)


def _make_aiosqlite_stop_idempotent() -> None:
    """A second ``aiosqlite.Connection.stop()`` returns no future to wait on.

    ``stop()`` queues a sentinel that ends the connection's worker thread and
    returns a future the worker resolves. A SECOND stop queues another sentinel
    behind the first — the worker has exited by then, so that future never
    resolves. SQLAlchemy reaches exactly that when a cancel lands while it
    terminates a connection: ``terminate()`` shields ``close()``, is cancelled,
    and falls back to ``stop()``; the shielded ``close()`` then calls ``stop()``
    in its ``finally`` and awaits the orphan future forever. Nothing can cancel
    it (it is shielded), so the loop's shutdown — ``asyncio.run`` gathering its
    tasks, a TestClient portal joining its thread — hangs with it. Under writer
    contention every connection sits in a 15s busy wait, so a cancel almost
    always lands there. Upstream as of aiosqlite 0.22.1 / SQLAlchemy 2.0.46.

    The stop also closes the sqlite handle it was called for. Upstream's
    sentinel reads ``self._connection`` when the worker runs it, but a
    ``close()`` that follows the stop sets that to None first: its own call is
    refused ("Connection closed") and its ``finally`` clears the attribute. The
    worker then exits without closing anything, and while any cursor still
    references the handle, its transaction and the writer lock stay held.
    """
    import aiosqlite
    import aiosqlite.core as core

    stop = aiosqlite.Connection.stop
    if getattr(stop, "_flow_idempotent", False):
        return

    def _stop_once(self):
        if not self._running:
            return None  # already stopping: the first sentinel ends the worker
        self._running = False
        handle = self._connection

        def close_and_stop():
            _detach_and_release(self, handle)
            return core._STOP_RUNNING_SENTINEL

        try:
            future = asyncio.get_event_loop().create_future()
        except Exception:  # noqa: BLE001 — no loop in this thread, as upstream
            future = None
        self._tx.put_nowait((future, close_and_stop))
        return future

    _stop_once._flow_idempotent = True
    aiosqlite.Connection.stop = _stop_once


def _release_connections_whose_loop_closed() -> None:
    """A connection whose event loop closed under it closes its sqlite handle.

    aiosqlite runs every call on a worker thread and hands the outcome back
    through the caller's loop. When that loop has closed, the hand-back raises
    ``RuntimeError: Event loop is closed``. Upstream the error escapes the
    worker, so the thread dies and the sqlite handle stays open with whatever
    transaction it holds. Nothing can release it now: every rollback, close or
    stop is queued to a thread that no longer exists, and a caller awaiting one
    waits forever. If the call in flight was a ``BEGIN IMMEDIATE`` waiting out
    busy_timeout, it takes the writer lock after its owner is gone and holds it
    for the rest of the process. That is how a pytest-timeout during a
    TestClient startup, whose portal loop closes without waiting for the
    worker, left every later test in the session "database is locked"
    (QA cycle 2026-09-23).

    A closed loop can never resume the coroutine that owned the call, so the
    connection is abandoned. The worker closes the handle on its own thread,
    which rolls back and releases the lock. It detaches the handle so later
    ``close()``/``stop()`` calls return at once, answers anything still
    queued, and exits. Upstream as of aiosqlite 0.22.1.
    """
    import queue
    import weakref

    import aiosqlite.core as core

    init = core.Connection.__init__
    if getattr(init, "_flow_releases_on_closed_loop", False):
        return

    def _handoff(future, deliver, value) -> bool:
        """Resolve ``future`` on its loop; False when that loop has closed."""
        try:
            future.get_loop().call_soon_threadsafe(deliver, future, value)
        except RuntimeError:
            if not future.get_loop().is_closed():
                raise
            return False
        return True

    def _step(future, function) -> tuple[bool, bool]:
        """Run one queued call and hand its outcome to its caller.

        Returns (handed back — False when the caller's loop has closed,
        the call was the stop sentinel).
        """
        try:
            deliver, value = core.set_result, function()
        except BaseException as e:  # noqa: BLE001 — every outcome goes to its caller
            deliver, value = core.set_exception, e
        handed_back = future is None or _handoff(future, deliver, value)
        return handed_back, deliver is core.set_result and value is core._STOP_RUNNING_SENTINEL

    def _abandon(tx, conn_ref) -> None:
        conn = conn_ref()
        if conn is not None:
            conn._running = False
            _detach_and_release(conn, conn._connection)
        while True:
            try:
                future, function = tx.get_nowait()
            except queue.Empty:
                return
            _step(future, function)

    def _worker(tx, conn_ref) -> None:
        while True:
            handed_back, stopped = _step(*tx.get())
            if not handed_back:
                _abandon(tx, conn_ref)
                return
            if stopped:
                return

    def _init(self, *args, **kwargs):
        init(self, *args, **kwargs)
        self._thread = threading.Thread(target=_worker, args=(self._tx, weakref.ref(self)))

    _init._flow_releases_on_closed_loop = True
    core.Connection.__init__ = _init


def _patch_aiosqlite() -> None:
    """Both patches reach into aiosqlite internals as of 0.22; on any other
    version they could silently mis-drive its worker, so they stand down."""
    import aiosqlite

    if not aiosqlite.__version__.startswith("0.22."):
        logger.warning(
            "sqlite: aiosqlite %s is not 0.22.x — the stop/closed-loop patches are not installed",
            aiosqlite.__version__,
        )
        return
    _make_aiosqlite_stop_idempotent()
    _release_connections_whose_loop_closed()


_patch_aiosqlite()


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

    Transaction discipline is split by intent (``FLOW_WRITER_OPT``):

    WRITE path (default): BEGIN IMMEDIATE on every transaction so SQLite
    acquires the writer lock up-front instead of upgrading mid-transaction.
    This eliminates the "SQLITE_BUSY despite busy_timeout" trap that fires
    when a deferred transaction starts as a reader and then tries to
    upgrade after another writer has taken the lock.

    READ path (``FLOW_WRITER_OPT=False``, set by the driver's reader
    session factory): emit NO BEGIN at all. Under WAL, readers need no
    lock — each SELECT runs against a consistent snapshot in DBAPI-level
    autocommit. Forcing reads through BEGIN IMMEDIATE (the previous
    behavior) made every SELECT queue on the single writer slot, so a
    long-running writer (e.g. an indexer batch) froze every read-serving
    endpoint for the duration of its transaction.
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
        # Reader connections (FLOW_WRITER_OPT=False) emit no BEGIN: SELECTs
        # run in DBAPI autocommit against a WAL snapshot, never touching the
        # writer lock. Everything else keeps the up-front BEGIN IMMEDIATE.
        if conn.get_execution_options().get(FLOW_WRITER_OPT, True):
            t_begin = time.monotonic()
            _begin_immediate(conn)
            # Timed only while the tag is on: every write in the app passes here.
            if not toplog.is_on("agentic_process.load"):
                return
            locked_at = conn.info["flow_writer_locked_at"] = time.monotonic()
            wait_ms = (locked_at - t_begin) * 1000
            if wait_ms > 200:
                toplog.log("agentic_process.load", "db writer lock waited ms=%.0f by=%s", wait_ms, _writer_label())

    def _on_release(conn):
        # A connection invalidated mid-transaction (a task cancelled inside a write)
        # raises PendingRollbackError on `.info` — from INSIDE its own rollback, which
        # then never completes and leaves the session unusable. Nothing to time there.
        if conn.invalidated:
            return
        locked_at = conn.info.pop("flow_writer_locked_at", None)
        if locked_at is None:
            return
        held_ms = (time.monotonic() - locked_at) * 1000
        if held_ms > 500:
            toplog.log("agentic_process.load", "db writer lock held ms=%.0f by=%s", held_ms, _writer_label())

    event.listen(engine.sync_engine, "commit", _on_release)
    event.listen(engine.sync_engine, "rollback", _on_release)


def _writer_label() -> str:
    """The asyncio task holding a write (name + coroutine) and the request it came from.

    Both, because a task detached from a request (``create_task`` in a handler)
    inherits that request's context: the path alone would blame the request for
    work its background task does long after the response.
    """
    try:
        task = asyncio.current_task()
    except RuntimeError:
        task = None
    if task is None:
        writer = "no-task"
    else:
        # An unnamed task ("Task-123") says nothing; its coroutine names the writer.
        coro = task.get_coro()
        writer = f"{task.get_name()}:{getattr(coro, '__qualname__', type(coro).__name__)}"
    try:
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

        request_info = get_current_request_info()
        request = getattr(request_info, "request", None) if request_info else None
        if request is not None:
            return f"{writer} from {request.method} {request.url.path}"
    except Exception:
        pass
    return writer


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


