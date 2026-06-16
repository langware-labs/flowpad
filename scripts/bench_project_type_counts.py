#!/usr/bin/env python3
"""Benchmark the per-(project, type) asset-count query against a synthetic DB
mirroring the real `entities` schema, with and without the partial index added
at init (ix_entities_project_type_counts in sqlite_driver._migrate_schema).

The index leads with the GROUP BY columns (project_id, type) and is restricted
to scoped rows, so the aggregate streams in index order and skips the temp
B-tree sort — ~25x on large indexes.

Run:  python3 scripts/bench_project_type_counts.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import time

# Mirrors the project predicate in _scope_sql_clause() and the committed index.
COUNT_SQL = """
SELECT json_extract(data, '$.project_id') AS project_id,
       type,
       COUNT(*) AS cnt
FROM entities
WHERE json_extract(data, '$.scope') IN ('project', 'system')
  AND json_extract(data, '$.project_id') IS NOT NULL
GROUP BY project_id, type
ORDER BY project_id, type
"""

PARTIAL_INDEX = """
CREATE INDEX ix_entities_project_type_counts
ON entities(json_extract(data, '$.project_id'), type)
WHERE json_extract(data, '$.scope') IN ('project', 'system')
  AND json_extract(data, '$.project_id') IS NOT NULL
"""

DDL = """
CREATE TABLE entities (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, namespace TEXT, key TEXT, uname TEXT,
  type_uname TEXT UNIQUE, data TEXT, record_data_ref TEXT
);
CREATE INDEX ix_entities_type ON entities(type);
"""

TYPES = ["markdown", "skill", "agent", "workflow", "command", "prompt", "plan",
         "whiteboard", "conversation", "claude_session", "todo", "hook", "plugin",
         "claude_md", "agent_trace"]


def make_data(scope: str, project_id: str, name: str) -> str:
    # A realistic-sized blob so json_extract has a real per-row parse cost.
    return json.dumps({
        "scope": scope, "project_id": project_id, "name": name,
        "asset_ref": f"/Users/dev/projects/{project_id}/.claude/skills/{name}/SKILL.md",
        "description": "A representative description field of moderate length.",
        "created_at": "2026-06-15T00:00:00Z", "modified_at": "2026-06-15T00:00:00Z",
        "tags": ["alpha", "beta"], "meta": {"x": 1, "y": 2},
    })


def populate(con: sqlite3.Connection, n_rows: int, n_projects: int) -> None:
    rows = []
    for i in range(n_rows):
        t = TYPES[i % len(TYPES)]
        bucket = i % 20  # ~85% project-scoped, 10% user, 5% empty-scope.
        if bucket < 17:
            scope, pid = "project", f"proj-{i % n_projects:04d}"
        elif bucket < 19:
            scope, pid = "user", ""
        else:
            scope, pid = "", ""
        rows.append((f"id-{i}", t, make_data(scope, pid, f"{t}-{i}")))
    con.executemany("INSERT INTO entities (id, type, data) VALUES (?,?,?)", rows)
    con.commit()


def time_query(con: sqlite3.Connection, runs: int = 7) -> tuple[float, int]:
    con.execute(COUNT_SQL).fetchall()  # warm up
    samples = []
    nres = 0
    for _ in range(runs):
        t0 = time.perf_counter()
        nres = len(con.execute(COUNT_SQL).fetchall())
        samples.append((time.perf_counter() - t0) * 1000.0)
    samples.sort()
    return samples[len(samples) // 2], nres


def plan(con: sqlite3.Connection) -> str:
    return " | ".join(r[-1] for r in con.execute("EXPLAIN QUERY PLAN " + COUNT_SQL).fetchall())


def bench(n_rows: int, n_projects: int = 20) -> None:
    path = tempfile.mktemp(suffix=".db")
    try:
        con = sqlite3.connect(path)
        con.executescript(DDL)
        populate(con, n_rows, n_projects)
        con.execute("ANALYZE")

        med0, nres = time_query(con)
        sort0 = "+sort" if "TEMP" in plan(con) else "no sort"

        con.execute(PARTIAL_INDEX)
        con.execute("ANALYZE")
        med1, _ = time_query(con)
        sort1 = "+sort" if "TEMP" in plan(con) else "no sort"

        print(f"\n=== {n_rows:>7,} rows | {n_projects} projects | {nres} (project,type) groups ===")
        print(f"  no index    : {med0:8.2f} ms  [{sort0}]")
        print(f"  partial idx : {med1:8.2f} ms  [{sort1}]   {med0 / med1:.1f}x")
    finally:
        if os.path.exists(path):
            os.remove(path)


if __name__ == "__main__":
    print(f"sqlite3 version: {sqlite3.sqlite_version}")
    for n in (1_000, 10_000, 50_000, 200_000):
        bench(n)
