---
id: 8106572b-f02b-5e7c-a9e7-c528fc03e0b5
---

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

- **WAL mode + production pragmas** on every aiosqlite connection,
  installed via a `connect` event listener in
  `flow_sdk/db/drivers/sqlite/connection.py:install_pragmas_and_immediate`.
- **`BEGIN IMMEDIATE` on every transaction**, installed via a `begin`
  event listener in the same `install_pragmas_and_immediate`. This is
  live in production (see "BEGIN IMMEDIATE" below).
- **`NullPool`** (every operation opens a fresh aiosqlite connection;
  see "Why NullPool" below).
- **Driver methods share a single session via `_session_ctx()`**: a
  contextvar-backed helper in `SQLiteDBDriver` that yields a request
  session if one exists, an outer standalone session if nested in the
  same task, otherwise opens a fresh session that commits on exit.
- **Single import for everyone**: `from flow_sdk.db import session`
  yields the request session inside a request, a fresh auto-committing
  session outside one.
- **Wiki layer** (`flow_sdk/wiki/`) runs over the **same engine** via
  `AsyncLinkStore`. No more sync `sqlite3` connection alongside.

### What's intentionally NOT wired

- **Per-request transaction binding** (`RequestTransactionMiddleware`
  passing the driver's `transaction_factory`) was tried but causes
  test-isolation issues. Driver methods open and commit their own
  short-lived sessions via `_session_ctx` instead. The middleware
  infrastructure is still in place (`RequestTransactionMiddleware` is
  registered in `flow_sdk/server/flow_server.py:86`) but the
  per-request transaction binding is left unwired — see
  `request_transaction_middleware.py:143`.

## Why NullPool

The SQLAlchemy default for aiosqlite + file DB is `AsyncAdaptedQueuePool`,
and that's what every "production SQLite" guide recommends. We don't use
it for two reasons:

1. **The async-tests conftest tears down via a new event loop**. aiosqlite
   worker threads are bound to the loop they were created on; pooled
   connections that survive across that teardown become zombies that
   still hold the SQLite writer lock. The next test's `BEGIN IMMEDIATE`
   sees `database is locked` and waits up to `busy_timeout` for nothing.
   With `NullPool`, connections are opened-and-closed per operation, so
   there is nothing to leak.
2. **SQLite locking is database-wide**. Pool reuse for SQLite saves at
   most a sub-millisecond connection setup; WAL mode + the page cache
   already absorb most read cost. For a desktop app with modest
   concurrency, the perf win is not worth the complexity.

All the writer-lock-friendly behavior comes from the pragmas + `BEGIN
IMMEDIATE`, not from the pool. (The driver picks `NullPool` explicitly
in `sqlite_driver.py:329`: `create_async_engine(url, echo=False,
poolclass=NullPool)`.)

## The pragmas, and why each one

```python
PRAGMA journal_mode=WAL          # readers concurrent with one writer
PRAGMA synchronous=NORMAL        # safe with WAL, fsync only on checkpoint
PRAGMA busy_timeout=15000        # 15s wait on writer-lock contention
PRAGMA temp_store=MEMORY         # temp tables in RAM
PRAGMA cache_size=-64000         # 64 MB page cache
PRAGMA mmap_size=268435456       # 256 MB memory-mapped I/O for reads
PRAGMA foreign_keys=OFF          # FKs enforced at app level, not by SQLite DDL
```

These are set **on every new aiosqlite connection** by a
`@event.listens_for(engine.sync_engine, "connect")` listener. WAL mode is
sticky at the file level; the rest are per-connection so the listener is
the right place. `foreign_keys` is set explicitly to `OFF` because the
schema doesn't declare FK constraints in its SQL DDL (FKs are enforced at
the app level); the sync `open_sqlite` path applies the identical pragma
set (`_SYNC_PRAGMAS` in `connection.py`) so a process touching the same
file through both paths never mixes WAL with rollback-journal.

`busy_timeout=15000` is the single most important pragma for "database is
locked". Without it, SQLite returns `SQLITE_BUSY` immediately when a
writer is contended; with it, the connection sleeps up to 15 seconds for
the lock to free. Aligns with the
[OneUptime SQLite production guide](https://oneuptime.com/blog/post/2026-02-02-sqlite-production-setup/view)
and the SQLAlchemy docs.

## BEGIN IMMEDIATE — live

SQLite has a subtle trap (Bert Hubert's "locked despite timeout"): a
transaction that starts with a `SELECT` acquires a SHARED lock, and when
it later tries to `UPDATE/DELETE/INSERT` it must upgrade to RESERVED. If
another writer already holds RESERVED, SQLite returns `SQLITE_BUSY`
immediately, ignoring `busy_timeout`.

The textbook fix is to open every transaction with `BEGIN IMMEDIATE` so
the writer lock is acquired up-front. This is wired in production via a
`begin` event listener registered alongside the pragmas in
`install_pragmas_and_immediate`:

```python
@event.listens_for(engine.sync_engine, "begin")
def _on_begin(conn):
    conn.exec_driver_sql("BEGIN IMMEDIATE")
```

Combined with WAL + `busy_timeout=15000`, this eliminates both the
original "close-shells flood" cascade and the read-then-write upgrade
trap. The contention this once caused with the api-test scaffolding (each
test's teardown closing the SQLite driver on a fresh throwaway event
loop, leaving the WAL writer lock held by an orphan worker thread) no
longer blocks it — the part that stayed unwired is the per-request
transaction binding in the middleware, not the `begin`-listener itself
(see next section).

## Per-request transaction (scaffolded but disabled)

`RequestTransactionMiddleware` is a pure ASGI middleware that has the
machinery to open one session per request, share it with all driver
calls during the request, and commit/rollback at the end. The wiring
exists: `ExecutionContext.commit_transaction()`,
`SQLiteTransactionHandler.commit/rollback/close`,
`get_current_transaction()` for driver methods to find the request
session via `_session_ctx`.

It is currently **passed `None` instead of the driver factory** because
of the test-scaffolding issue described in the BEGIN IMMEDIATE section
above. Re-enabling is a one-line change once the test teardown pattern
is updated.

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
`flow_sdk.db.database` — are preserved as thin wrappers. `database.py` is
now a pure facade over the active driver: it owns **no** engine of its
own. There is exactly one engine, owned by the active `DBDriver`
instance (`get_db_driver()`); the old module-level `_engine` /
`_session_factory` globals are gone. `async_session` is just an alias for
`flow_sdk.db.session`, and `init_db` / `close_db` delegate to
`get_db_driver().open()` / `.close()`.

## What stays sync

`flow_sdk/system_tools.py:299` (`validate_db()`, PRAGMA integrity_check)
and `:470` (`get_database_stats()`, diagnostic COUNT queries) stay sync.
They no longer call `sqlite3.connect` directly — both route through
`open_sqlite()` in `connection.py`, so the WAL + `busy_timeout` pragma
discipline is uniform across sync and async paths (mixing pragma
configurations on the same file is a documented SQLite corruption
vector). They're short-lived, no transaction, run outside the async
stack, and exist for offline diagnostics — making them async would buy
nothing.

## What landed and what didn't

**Landed**:

- `_session_ctx()` helper on the driver with the contextvar handshake
  for nested same-task calls.
- All ~47 driver methods refactored to use `_session_ctx()` instead of
  per-method open+commit. `_create_entity` uses `flush()` so the
  IntegrityError → `HTTPException(409)` mapping for `type_uname` stays
  local.
- Full pragma set + `BEGIN IMMEDIATE` (`begin` listener) installed via
  `install_pragmas_and_immediate` in `connection.py`. The engine uses
  `NullPool` (set in `sqlite_driver.py`).
- `flow_sdk.db.session` and `Entity` / `Relationship` re-exports.
- `AsyncLinkStore` over the shared engine. Wiki indexer and resolver
  are now async. All wiki call sites in `entity_model.py`, `fs_record.py`,
  and `wiki_action.py` use `await`. The sync `LinkStore` is deleted.
- `FSRecord.sync_to_db` (`flow_sdk/fs_store/fs_record.py:530`) opens one
  shared session for the whole entity + FTS + wiki write so bulk indexer
  paths don't pay per-step connection setup.
- `BEGIN IMMEDIATE` on every transaction (`begin` event listener).
- Collapsing `database.py` to a pure facade with no engine of its own.

**Tried and reverted**:

- `RequestTransactionMiddleware` wiring
  `get_db_driver().get_transaction_factory()` per request.

The per-request transaction binding interacted with the existing test
scaffolding's "new event loop per teardown" pattern in ways that caused
`database is locked` cascades between tests (root cause traces to
SQLAlchemy issue #8145: async connection close needs async I/O that
can't reliably run during non-context-managed teardown). The full pragma
set + `BEGIN IMMEDIATE` + single-session indexer path are sufficient for
the writer-lock cascade the refactor was meant to solve. The middleware
infrastructure remains in place and the binding can be re-enabled once
the test teardown is updated to drain aiosqlite worker threads on the
same loop they were created on.

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
- `flow_sdk/fs_store/fs_record.py`
- `flow_sdk/app/actions/wiki_action.py`

Tests:
- `tests/api/conftest.py` — drop references to deleted globals
- `tests/wiki/test_store.py`, `tests/wiki/test_resolver.py` — full async rewrite
- `tests/wiki/test_backlink_count_lifecycle.py`, `tests/wiki/test_skill_links_to_agentic_process.py` — `await`
