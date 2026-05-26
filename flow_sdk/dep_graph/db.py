from __future__ import annotations

import sqlite3
from pathlib import Path


def dep_graph_db_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings
    return get_instance_settings().db_path.parent / "dep_graph.db"


_SCHEMA = """
CREATE TABLE IF NOT EXISTS dep_nodes (
  type      TEXT NOT NULL,
  id        TEXT NOT NULL,
  label     TEXT,
  is_ghost  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type, id)
);

CREATE TABLE IF NOT EXISTS dep_edges (
  from_type  TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_type    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  PRIMARY KEY (from_type, from_id, to_type, to_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_dep_edges_to   ON dep_edges(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_dep_edges_from ON dep_edges(from_type, from_id);
"""


def open_dep_graph_db(path: Path | None = None) -> sqlite3.Connection:
    path = path or dep_graph_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    # WAL is a persistent setting on the database file — set it the first
    # time we touch the file and let subsequent opens inherit it.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(_SCHEMA)
    conn.commit()


def reset(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM dep_edges")
    conn.execute("DELETE FROM dep_nodes")
    conn.commit()
