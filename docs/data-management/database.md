# Database Architecture

How the SQLite layer is wired in flow-cli — one async engine, one transaction
per HTTP request, one ergonomic import for handlers and ORM-style objects.

This document captures the decisions made during the **v0.2.8 async DB
refactor** (2026-04). The motivation was a `database is locked` cascade
under a "close 100+ shells in parallel" flood. The investigation surfaced
five compounding issues, not one bug: missing pragmas on the hot-path
engine, a duplicate engine on the same SQLite file, a sync `sqlite3`
singleton in the wiki layer running from inside async handlers,
per-method `commit()` instead of one transaction per request, and
`SELECT then UPDATE` patterns that hit
[Bert Hubert's "SQLITE_BUSY despite timeout" trap](https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/).

## TL;DR

- **One SQLAlchemy `AsyncEngine`** per process, owned by `SQLiteDBDriver`
  (`flow_sdk/db/drivers/sqlite/sqlite_driver.py`).
- **WAL mode + production pragmas + `BEGIN IMMEDIATE` on every transaction**,
  installed via `connect` and `begin` event listeners in
  `flow_sdk/db/drivers/sqlite/connection.py:install_pragmas_and_immediate`.
- **`AsyncAdaptedQueuePool`** (the SQLAlchemy 2.0 default for aiosqlite +
  file DB). NOT `NullPool`.
- **One transaction per HTTP request**: `RequestTransactionMiddleware`
  (`flow_sdk/server/middleware/request_transaction_middleware.py`)
  opens a session at request start, commits on success, rolls back on
  exception, closes on cleanup. All driver methods see this session
  via a contextvar handshake.
- **Single import for everyone**: `from flow_sdk.db import session`
  yields the request session inside a request, a fresh auto-committing
  session outside one.
- **Wiki layer** (`flow_sdk/wiki/`) runs over the **same engine** via
  `AsyncLinkStore`. No more sync `sqlite3` connection alongside.

## The pragmas, and why each one

```python
PRAGMA journal_mode=WAL          # readers concurrent with one writer
PRAGMA synchronous=NORMAL        # safe with WAL, fsync only on checkpoint
PRAGMA busy_timeout=5000         # 5s wait on writer-lock contention
PRAGMA temp_store=MEMORY         # temp tables in RAM
PRAGMA cache_size=-64000         # 64 MB page cache
PRAGMA mmap_size=268435456       # 256 MB memory-mapped I/O for reads
PRAGMA foreign_keys=ON           # enforce FK constraints
```

These are set **on every new aiosqlite connection** by a
`@event.listens_for(engine.sync_engine, "connect")` listener. WAL mode is
sticky at the file level; the rest are per-connection so the listener is
the right place.

`busy_timeout=5000` is the single most important pragma for "database is
locked". Without it, SQLite returns `SQLITE_BUSY` immediately when a
writer is contended; with it, the connection sleeps up to 5 seconds for
the lock to free. Aligns with the
[OneUptime SQLite production guide](https://oneuptime.com/blog/post/2026-02-02-sqlite-production-setup/view)
and the SQLAlchemy docs.

## BEGIN IMMEDIATE — and why on every transaction

SQLite has a subtle trap: a transaction that starts with a `SELECT`
acquires a SHARED lock, and when it later tries to `UPDATE/DELETE/INSERT`
it must upgrade to RESERVED. **If another writer already holds RESERVED,
SQLite returns `SQLITE_BUSY` immediately, ignoring `busy_timeout`** —
because allowing the upgrade would violate serializable isolation. This
is what Bert Hubert's article calls "locked despite timeout".

The fix: open the transaction with `BEGIN IMMEDIATE` so the writer lock
is acquired up-front. Then `busy_timeout` actually waits.

We apply `BEGIN IMMEDIATE` **unconditionally** via:

```python
@event.listens_for(engine.sync_engine, "begin")
def _on_begin(conn):
    conn.exec_driver_sql("BEGIN IMMEDIATE")
```

Trade-off: read-only requests now also briefly take the writer lock. For
a desktop app like Flowpad where almost every endpoint writes (audit
fields, FTS upsert, link extraction), this is the right call. Tagging
read-only handlers per-route is a maintenance burden and a footgun. We
revisit if profiling proves a problem.

## One transaction per HTTP request

`RequestTransactionMiddleware` is a pure ASGI middleware (not
`BaseHTTPMiddleware`) so context variables propagate cleanly through the
request lifecycle. Sequence:

```
HTTP request comes in
  → RequestTransactionMiddleware.__call__
    → resolve transaction_factory from get_db_driver()
    → ExecutionContext(False, transaction_factory)
      → setup() opens AsyncSession, attaches as
        request_info.transaction_handler.db_transaction
      → handler runs; all driver methods + AsyncLinkStore
        + session() context manager piggyback on the same session
      → on success: commit_transaction()  (this writes the changes)
      → on exception: rollback_transaction()
    → cleanup() closes the session
```

Two important details:

1. **`ExecutionContext.cleanup()` is close-only**, not "commit then
   close". Durability is the explicit responsibility of the success path
   (`commit_transaction`) or exception path (`rollback_transaction`).
   The middleware drives this distinction. `cleanup()` runs in `finally`
   on both paths.

2. **WebSocket handlers are not covered** by this middleware (it
   short-circuits on `scope["type"] != "http"`). If a future WebSocket
   handler writes to the DB, it needs an analogous wrapper.

## Driver session resolution

Inside `SQLiteDBDriver`, every public method goes through one helper:

```python
@asynccontextmanager
async def _session_ctx(self):
    """Resolution order:
    1. Request-bound session (via SQLiteTransactionHandler.db_transaction)
    2. Standalone-task-bound session (set by an outer _session_ctx in same task)
    3. New fresh session: commit on success, rollback on exception, close on exit
    """
    ...
```

The contextvar handshake in (2) is what lets a method like
`SQLiteDBDriver.delete()` call `get_children_sub_tree()` (which itself
calls `_session_ctx`) without those nested calls racing for the writer
lock against each other. Outside a request, all the nested driver work
on the same task collapses onto a single session.

## Single import

Public ergonomic API:

```python
from flow_sdk.db import session, Entity, Relationship, get_db_driver

# In a route handler — yields the request session.
async with session() as s:
    result = await s.execute(...)

# In a CLI script — yields a fresh session, auto-commits on exit.
async with session() as s:
    ...
```

`Entity` and `Relationship` are aliases for `DBEntity` /
`DBRelationship`. The `LazyDBDriver` descriptor on those classes points
at the same single `SQLiteDBDriver` instance everyone uses.

Legacy names — `init_db`, `close_db`, `async_session`, `reinit_db` from
`flow_sdk.db.database` — are preserved as a thin facade over
`get_db_driver()` so call-sites in `flow_server.py`, `bootstrap.py`,
`compute_cmd.py`, `system_tools.py`, and tests keep working.

## What stays sync

`flow_sdk/system_tools.py:261, 410` keeps a `sqlite3.connect` for
`validate_db()` (PRAGMA integrity_check) and `get_db_statistics()`
(diagnostic COUNT queries). They're short-lived, no transaction, run
outside the async stack, and exist for offline diagnostics — making them
async would buy nothing.

## Migration order (for future reference)

The refactor was sequenced to keep `pytest tests/unit tests/api
tests/wiki` green at every step:

1. Add `_session_ctx()` helper to driver (no callers yet).
2. Install full pragmas + `BEGIN IMMEDIATE` on the driver engine.
3. Drop `NullPool`, switch to `AsyncAdaptedQueuePool`.
4. Refactor 47 driver methods to use `_session_ctx()` and remove inline
   `session.commit()` calls. `_create_entity` swaps `commit()` for
   `flush()` so the IntegrityError → `HTTPException(409)` mapping for
   `type_uname` collisions stays local.
5. Wire `RequestTransactionMiddleware` to pass the driver's transaction
   factory; add explicit success-path commit before cleanup.
6. Collapse `flow_sdk/db/database.py` to a thin facade over
   `get_db_driver()`. Delete `create_engine_and_session()` from
   `connection.py`.
7. Add `flow_sdk.db.session` and `Entity` / `Relationship` re-exports.
8. Add `AsyncLinkStore` alongside the legacy sync `LinkStore`.
9. Async-ify `wiki/indexer.py` and `wiki/resolver.py`; update wiki
   tests to async fixtures.
10. Add `await` at every wiki call site (`entity_model.py`, `record.py`,
    `wiki_action.py`); flip `Entity.get_links` / `get_backlinks` and
    `Record.get_links` / `get_backlinks` from sync properties to
    async methods.
11. Delete the sync `LinkStore`.
12. Write this document.

## References

- [SQLAlchemy 2.0 — SQLite dialect](https://docs.sqlalchemy.org/en/20/dialects/sqlite.html)
- [SQLAlchemy 2.0 — Connection Pooling](https://docs.sqlalchemy.org/en/20/core/pooling.html)
- [Going Fast with SQLite and Python — Charles Leifer](https://charlesleifer.com/blog/going-fast-with-sqlite-and-python/)
- [SQLite Production Setup — OneUptime](https://oneuptime.com/blog/post/2026-02-02-sqlite-production-setup/view)
- [SQLITE_BUSY despite timeout — Bert Hubert](https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/)
- [Abusing SQLite for Concurrency — SkyPilot](https://blog.skypilot.co/abusing-sqlite-to-handle-concurrency/)
- [aiosqlitepool](https://github.com/slaily/aiosqlitepool) — alternative pool layer; not adopted but worth knowing
- [SQLite — Using SQLite In Multi-Threaded Applications](https://sqlite.org/threadsafe.html)

## Files changed in this refactor

Primary:
- `flow_sdk/db/drivers/sqlite/sqlite_driver.py`
- `flow_sdk/db/drivers/sqlite/connection.py`
- `flow_sdk/db/database.py`
- `flow_sdk/db/__init__.py`
- `flow_sdk/server/middleware/request_transaction_middleware.py`
- `flow_sdk/request_context/execution_context.py`
- `flow_sdk/wiki/store.py`
- `flow_sdk/wiki/indexer.py`
- `flow_sdk/wiki/resolver.py`

Wiki call sites (added `await`):
- `flow_sdk/core/entity/entity_model.py`
- `flow_sdk/fs_store/record.py`
- `flow_sdk/app/actions/wiki_action.py`

Tests:
- `tests/api/conftest.py` — drop references to deleted globals
- `tests/wiki/test_store.py`, `tests/wiki/test_resolver.py` — full async rewrite
- `tests/wiki/test_backlink_count_lifecycle.py`, `tests/wiki/test_skill_links_to_agentic_process.py` — `await`
