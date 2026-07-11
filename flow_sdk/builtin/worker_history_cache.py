"""Persistent per-transcript derived-stats cache for the worker-history endpoint.

``worker_history``'s collectors re-derive display stats (title, last prompt,
message count, …) by parsing each candidate transcript on every request; the
per-record memo (``_session_batch_stats``) dies with the request, so nothing is
reused across calls. This module gives those collectors a cross-request cache
keyed by transcript path and validated by ``(st_mtime_ns, st_size)`` — a row is
served only while the file is byte-identical to when it was parsed, so cached
values can never go stale (residual risk: a rewrite that preserves both mtime_ns
and size, which no real transcript writer does).

Scope is deliberately narrow: only the ``worker_history`` collectors read or
write it. It does NOT front ``ensure_claude_session_stats`` /
``_parse_jsonl_stats`` — analytics callers (usage_report, cost_overview) need
the full token/cost stats and keep their own parse path.

The cache lives in its own sqlite file (``worker_history_cache.sqlite`` in the
instance dir), never the main flowpad.db, so cold-fill write bursts can't
contend with the app DB writer. It is disposable by construction: every error
degrades to a miss (collectors fall back to parsing), and corruption is healed
by deleting and recreating the file.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from pathlib import Path

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1

# Rows not refreshed within this horizon are pruned on the next write — keeps
# orphans from deleted transcripts bounded without a maintenance job.
_PRUNE_AFTER_SECONDS = 30 * 24 * 3600

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS session_stats (
    path       TEXT PRIMARY KEY,
    mtime_ns   INTEGER NOT NULL,
    size       INTEGER NOT NULL,
    provider   TEXT NOT NULL,
    payload    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
)
"""


class WorkerSessionStatsCache:
    """``(path, mtime_ns, size)``-validated payload store over one sqlite file.

    Connections are opened per operation and closed in ``finally`` — collectors
    run on arbitrary ``asyncio.to_thread`` pool threads, and open-per-call
    sidesteps sqlite's thread-affinity default without shared-connection locks.
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = Path(db_path)

    def get_many(self, keys: list[tuple[str, int, int]]) -> dict[str, dict]:
        """``{path: payload}`` for keys whose ``(mtime_ns, size)`` both match.

        Read-only; a missing/corrupt/mismatched-schema db is an all-miss, never
        an error, and the file is never created here.
        """
        if not keys:
            return {}
        try:
            conn = self._open_ro()
        except sqlite3.Error:
            return {}
        try:
            if self._user_version(conn) != SCHEMA_VERSION:
                return {}
            out: dict[str, dict] = {}
            paths = [k[0] for k in keys]
            expected = {k[0]: (k[1], k[2]) for k in keys}
            # SQLite's default host-parameter cap is 999; chunk to stay under it.
            for start in range(0, len(paths), 900):
                chunk = paths[start : start + 900]
                marks = ",".join("?" * len(chunk))
                rows = conn.execute(
                    f"SELECT path, mtime_ns, size, payload FROM session_stats WHERE path IN ({marks})",  # noqa: S608
                    chunk,
                ).fetchall()
                for path, mtime_ns, size, payload in rows:
                    if expected.get(path) != (mtime_ns, size):
                        continue
                    try:
                        out[path] = json.loads(payload)
                    except (TypeError, ValueError):
                        continue
            return out
        except sqlite3.Error as e:
            logger.debug("[worker_history_cache] get_many failed: %s", e)
            return {}
        finally:
            conn.close()

    def put_many(self, rows: list[tuple[str, int, int, str, dict]]) -> None:
        """Upsert ``(path, mtime_ns, size, provider, payload)`` rows in one
        transaction, then prune rows unrefreshed for the prune horizon.

        Corruption self-heal: on failure the db file (and -wal/-shm siblings)
        is deleted and the write retried once against a fresh file; a second
        failure is swallowed — the cache must never break the endpoint.
        """
        if not rows:
            return
        try:
            self._write(rows)
        except sqlite3.Error as e:
            logger.debug("[worker_history_cache] write failed (%s); recreating cache", e)
            self._unlink()
            try:
                self._write(rows)
            except sqlite3.Error as e2:
                logger.debug("[worker_history_cache] rewrite failed: %s", e2)

    # ── internals ──────────────────────────────────────────────────────────

    def _open_ro(self) -> sqlite3.Connection:
        from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415

        return open_sqlite(self._db_path, mode="ro")

    def _write(self, rows: list[tuple[str, int, int, str, dict]]) -> None:
        from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415

        now = int(time.time())
        conn = open_sqlite(self._db_path, mode="rw")
        try:
            self._ensure_schema(conn)
            with conn:  # one transaction for upserts + prune
                conn.executemany(
                    "INSERT OR REPLACE INTO session_stats"
                    " (path, mtime_ns, size, provider, payload, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    [
                        (path, mtime_ns, size, provider, json.dumps(payload), now)
                        for path, mtime_ns, size, provider, payload in rows
                    ],
                )
                conn.execute(
                    "DELETE FROM session_stats WHERE updated_at < ?",
                    (now - _PRUNE_AFTER_SECONDS,),
                )
        finally:
            conn.close()

    def _ensure_schema(self, conn: sqlite3.Connection) -> None:
        if self._user_version(conn) != SCHEMA_VERSION:
            with conn:
                conn.execute("DROP TABLE IF EXISTS session_stats")
                conn.execute(_CREATE_TABLE)
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        else:
            with conn:
                conn.execute(_CREATE_TABLE)

    @staticmethod
    def _user_version(conn: sqlite3.Connection) -> int:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])

    def _unlink(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            try:
                Path(str(self._db_path) + suffix).unlink(missing_ok=True)
            except OSError:
                pass
