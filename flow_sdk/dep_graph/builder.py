from __future__ import annotations

import json
import sqlite3
import time

from flow_sdk.db.drivers.sqlite.connection import get_database_path
from flow_sdk.fs_store.type_id import TypeId

from .db import init_schema, open_dep_graph_db, reset
from .types import DepGraphResult, Edge, EdgeKind, Node


_CONTEXT_FIELDS: tuple[tuple[str, EdgeKind], ...] = (
    ("shared_context_entities",   EdgeKind.CONTEXT_SHARED),
    ("private_context_entities_", EdgeKind.CONTEXT_PRIVATE),
)


def _typeid_from_ref(ref: object) -> TypeId | None:
    if isinstance(ref, str) and TypeId.is_typeid(ref):
        return TypeId(ref)
    if isinstance(ref, dict) and "type" in ref and "id" in ref:
        return TypeId(type=ref["type"], id=ref["id"])
    return None


def build_dep_graph(conn: sqlite3.Connection | None = None) -> DepGraphResult:
    """Walk the main flow.db, emit (node, edge) rows into the separate dep_graph.db.

    Read-only against the main DB; write-fresh against the dep graph DB.
    Synchronous bulk index — callers must offload to a thread when running
    inside an event loop.
    """
    started = time.perf_counter()
    own_conn = conn is None
    conn = conn or open_dep_graph_db()
    init_schema(conn)
    reset(conn)

    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415
    src = open_sqlite(get_database_path(), mode="ro")
    nodes: list[Node] = []
    edges: list[Edge] = []
    try:
        for row in src.execute("SELECT type, id, uname, data FROM entities"):
            type_, id_, uname = row["type"], row["id"], row["uname"]
            try:
                data = json.loads(row["data"] or "{}")
            except json.JSONDecodeError:
                data = {}
            label = uname or data.get("name") or data.get("title") or data.get("uname")
            nodes.append(Node(type=type_, id=id_, label=label))

            for field_name, kind in _CONTEXT_FIELDS:
                for ref in data.get(field_name) or []:
                    tid = _typeid_from_ref(ref)
                    if tid is None:
                        continue
                    edges.append(Edge(
                        from_type=type_, from_id=id_,
                        to_type=tid.type, to_id=tid.id,
                        kind=kind,
                    ))

        for row in src.execute(
            "SELECT from_type, from_id, to_type, to_id FROM relationships WHERE is_child = 1"
        ):
            edges.append(Edge(
                from_type=row["from_type"], from_id=row["from_id"],
                to_type=row["to_type"],     to_id=row["to_id"],
                kind=EdgeKind.CHILD,
            ))
    finally:
        src.close()

    known: set[tuple[str, str]] = {(n.type, n.id) for n in nodes}
    for e in edges:
        for t, i in ((e.from_type, e.from_id), (e.to_type, e.to_id)):
            if (t, i) not in known:
                nodes.append(Node(type=t, id=i, label=None, is_ghost=True))
                known.add((t, i))

    conn.executemany(
        "INSERT OR IGNORE INTO dep_nodes (type, id, label, is_ghost) VALUES (?, ?, ?, ?)",
        [(n.type, n.id, n.label, int(n.is_ghost)) for n in nodes],
    )
    conn.executemany(
        "INSERT OR IGNORE INTO dep_edges (from_type, from_id, to_type, to_id, kind) "
        "VALUES (?, ?, ?, ?, ?)",
        [(e.from_type, e.from_id, e.to_type, e.to_id, e.kind.value) for e in edges],
    )
    conn.commit()

    if own_conn:
        conn.close()

    return DepGraphResult(
        nodes=nodes,
        edges=edges,
        duration_ms=(time.perf_counter() - started) * 1000,
    )


def load_graph(conn: sqlite3.Connection | None = None) -> DepGraphResult:
    """Read whatever is in the dep graph DB right now — no rebuild."""
    own_conn = conn is None
    conn = conn or open_dep_graph_db()
    init_schema(conn)
    try:
        nodes = [
            Node(type=r["type"], id=r["id"], label=r["label"],
                 is_ghost=bool(r["is_ghost"]))
            for r in conn.execute(
                "SELECT type, id, label, is_ghost FROM dep_nodes"
            )
        ]
        edges = [
            Edge(
                from_type=r["from_type"], from_id=r["from_id"],
                to_type=r["to_type"],     to_id=r["to_id"],
                kind=EdgeKind(r["kind"]),
            )
            for r in conn.execute(
                "SELECT from_type, from_id, to_type, to_id, kind FROM dep_edges"
            )
        ]
    finally:
        if own_conn:
            conn.close()
    return DepGraphResult(nodes=nodes, edges=edges)
