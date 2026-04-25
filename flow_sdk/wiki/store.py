"""LinkStore — sync CRUD on the `links` table.

Uses a sync sqlite3 connection to the same DB file managed by the async
SQLAlchemy driver. The schema (`LinksSchema` in
`flow_sdk/db/drivers/sqlite/connection.py`) is created by
`Base.metadata.create_all` when the async driver opens — by the time
the store is first used, the table exists.

Sync deliberately: `Record.get_links()` and `Entity.get_links()` are
sync APIs; the brief blocking on a sqlite read/write is microseconds.
"""

from __future__ import annotations

import sqlite3
from typing import Iterable

from .types import WikiLink


_default_store: "LinkStore | None" = None


def get_default_store() -> "LinkStore":
    """Lazy singleton bound to whatever sqlite path the async driver is using."""
    global _default_store
    if _default_store is None:
        _default_store = LinkStore()
    return _default_store


def reset_default_store() -> None:
    """Drop the cached store. Useful when tests swap the underlying DB."""
    global _default_store
    if _default_store is not None:
        _default_store.close()
    _default_store = None


class LinkStore:
    """Per-database sync handle on the `links` table.

    Path defaults to whatever path the registered async driver is using —
    so production and tests pick up the right DB transparently as long as
    the driver was registered first (which it is, both in production and
    via `initialize_test_db` in the test conftest).
    """

    def __init__(self, path: str | None = None):
        if path is None:
            path = self._resolve_path()
        self._path = path
        self._conn: sqlite3.Connection | None = None

    @staticmethod
    def _resolve_path() -> str:
        from flow_sdk.db.drivers.db_driver import get_db_driver

        driver = get_db_driver()
        path = getattr(driver.config, "database", None)
        if not path:
            raise RuntimeError(
                "LinkStore: no database path on the registered driver. "
                "The async driver must be opened before the wiki layer is used."
            )
        return path

    def _connection(self) -> sqlite3.Connection:
        if self._conn is None:
            # autocommit; we manage transactions explicitly via BEGIN/COMMIT.
            self._conn = sqlite3.connect(self._path, isolation_level=None)
            self._conn.row_factory = sqlite3.Row
            try:
                self._conn.execute("PRAGMA journal_mode=WAL")
                self._conn.execute("PRAGMA busy_timeout=5000")
            except sqlite3.DatabaseError:
                pass
        return self._conn

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # ---------------- writes ----------------

    def replace_for_source(
        self, src_type: str, src_id: str, links: Iterable[WikiLink]
    ) -> None:
        """Atomic DELETE + INSERT for one source. Idempotent."""
        rows = [
            (src_type, src_id, link.raw, link.target_type, link.target_id, link.line)
            for link in links
        ]
        c = self._connection()
        c.execute("BEGIN")
        try:
            c.execute(
                "DELETE FROM links WHERE src_type = ? AND src_id = ?",
                (src_type, src_id),
            )
            if rows:
                c.executemany(
                    """
                    INSERT INTO links (
                        src_type, src_id, target_raw,
                        target_resolved_type, target_resolved_id, line
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    rows,
                )
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise

    # ---------------- reads ----------------

    def outgoing_from(self, src_type: str, src_id: str) -> list[WikiLink]:
        rows = self._connection().execute(
            """
            SELECT * FROM links
            WHERE src_type = ? AND src_id = ?
            ORDER BY line, id
            """,
            (src_type, src_id),
        ).fetchall()
        return [self._row_to_link(r) for r in rows]

    def backlinks_of(self, target_type: str, target_id: str) -> list[WikiLink]:
        rows = self._connection().execute(
            """
            SELECT * FROM links
            WHERE target_resolved_type = ? AND target_resolved_id = ?
            ORDER BY src_type, src_id, line, id
            """,
            (target_type, target_id),
        ).fetchall()
        return [self._row_to_link(r) for r in rows]

    def find_unresolved(self, target_raw: str) -> list[WikiLink]:
        rows = self._connection().execute(
            """
            SELECT * FROM links
            WHERE target_resolved_id IS NULL AND target_raw = ?
            """,
            (target_raw,),
        ).fetchall()
        return [self._row_to_link(r) for r in rows]

    @staticmethod
    def _row_to_link(row: sqlite3.Row) -> WikiLink:
        return WikiLink(
            id=row["id"],
            src_type=row["src_type"],
            src_id=row["src_id"],
            raw=row["target_raw"],
            target_type=row["target_resolved_type"],
            target_id=row["target_resolved_id"],
            line=row["line"],
        )
