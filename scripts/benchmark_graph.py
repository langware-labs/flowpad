#!/usr/bin/env python3
"""
Graph Query Benchmark — 100K nodes / 1M edges
Compares three strategies:
  1. Dump     — load all rows into plain Python dicts + adjacency list
  2. SQL      — SQLite indexes + json_each() + FTS5, CTE-based subgraph
  3. NetworkX — DiGraph with node/edge attributes, G.subgraph() for induced edges

Each query returns a full Cytoscape.js subgraph:
  {
    "elements": {
      "nodes": [{"data": {"id", "type", "created_date", "tags", "text"}}],
      "edges": [{"data": {"id", "source", "target", "type"}}]
    }
  }
Edges included = induced subgraph (both endpoints in matched node set).

Usage:
    python scripts/benchmark_graph.py                            # seed if needed, then benchmark
    python scripts/benchmark_graph.py --reset                    # force re-seed
    python scripts/benchmark_graph.py --num-nodes 1000 --num-edges 10000
"""

import argparse
import json
import os
import random
import sqlite3
import time
from collections import defaultdict

import networkx as nx

DB_PATH = "/tmp/graph_benchmark.db"
NUM_NODES = 100_000
NUM_EDGES = 1_000_000
BATCH_SIZE = 10_000

NODE_TYPES = ["note", "task", "doc", "event", "person"]
EDGE_TYPES = ["links", "depends", "refs"]
TAG_POOL = [f"tag{i}" for i in range(20)]
WORD_POOL = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
    "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
    "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey",
    "xray", "yankee", "zulu", "apple", "banana", "cherry", "date",
]

TS_END = time.time()
TS_START = TS_END - 365 * 24 * 3600


# ---------------------------------------------------------------------------
# Cytoscape JSON helpers
# ---------------------------------------------------------------------------

CytoGraph = dict  # {"elements": {"nodes": [...], "edges": [...]}}


def _node_element(nid: str, ntype: str, created_date: float, data_json: str) -> dict:
    d = json.loads(data_json)
    return {"data": {"id": nid, "type": ntype, "created_date": created_date,
                     "tags": d["tags"], "text": d["text"]}}


def _edge_element(eid: str, from_id: str, to_id: str, etype: str) -> dict:
    return {"data": {"id": eid, "source": from_id, "target": to_id, "type": etype}}


def _cyto(node_elements: list, edge_elements: list) -> CytoGraph:
    return {"elements": {"nodes": node_elements, "edges": edge_elements}}


def cyto_node_ids(g: CytoGraph) -> set[str]:
    return {n["data"]["id"] for n in g["elements"]["nodes"]}


def cyto_edge_ids(g: CytoGraph) -> set[str]:
    return {e["data"]["id"] for e in g["elements"]["edges"]}


# ---------------------------------------------------------------------------
# Seeder
# ---------------------------------------------------------------------------

def seed_db(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.executescript("""
        CREATE TABLE nodes (
            id           TEXT PRIMARY KEY,
            type         TEXT NOT NULL,
            created_date REAL NOT NULL,
            data         TEXT NOT NULL
        );
        CREATE INDEX idx_nodes_type         ON nodes(type);
        CREATE INDEX idx_nodes_created_date ON nodes(created_date);

        CREATE TABLE edges (
            id      TEXT PRIMARY KEY,
            from_id TEXT NOT NULL,
            to_id   TEXT NOT NULL,
            type    TEXT NOT NULL
        );
        CREATE INDEX idx_edges_from ON edges(from_id);
        CREATE INDEX idx_edges_to   ON edges(to_id);
        CREATE INDEX idx_edges_type ON edges(type);

        CREATE VIRTUAL TABLE nodes_fts USING fts5(
            node_id   UNINDEXED,
            text_body,
            tokenize='porter unicode61'
        );
    """)

    print(f"  Seeding {NUM_NODES:,} nodes …", flush=True)
    t0 = time.perf_counter()
    node_batch, fts_batch = [], []
    for i in range(NUM_NODES):
        nid = f"node-{i:07d}"
        ntype = NODE_TYPES[i % len(NODE_TYPES)]
        created = TS_START + random.random() * (TS_END - TS_START)
        tags = random.sample(TAG_POOL, random.randint(2, 4))
        words = random.sample(WORD_POOL, random.randint(5, 10))
        text = " ".join(words)
        data = json.dumps({"tags": tags, "text": text})
        node_batch.append((nid, ntype, created, data))
        fts_batch.append((nid, text))
        if len(node_batch) >= BATCH_SIZE:
            cur.executemany("INSERT INTO nodes VALUES (?,?,?,?)", node_batch)
            cur.executemany("INSERT INTO nodes_fts(node_id, text_body) VALUES (?,?)", fts_batch)
            conn.commit()
            node_batch.clear(); fts_batch.clear()
            print(f"    nodes: {i+1:,}", flush=True)
    if node_batch:
        cur.executemany("INSERT INTO nodes VALUES (?,?,?,?)", node_batch)
        cur.executemany("INSERT INTO nodes_fts(node_id, text_body) VALUES (?,?)", fts_batch)
        conn.commit()
    print(f"  Nodes done in {(time.perf_counter()-t0)*1000:.0f}ms", flush=True)

    print(f"  Seeding {NUM_EDGES:,} edges …", flush=True)
    t0 = time.perf_counter()
    seen_pairs: set[tuple[int, int]] = set()
    edge_batch = []
    e_idx = 0
    while e_idx < NUM_EDGES:
        a = random.randint(0, NUM_NODES - 1)
        b = random.randint(0, NUM_NODES - 1)
        if a == b or (a, b) in seen_pairs:
            continue
        seen_pairs.add((a, b))
        eid = f"edge-{e_idx:07d}"
        etype = EDGE_TYPES[e_idx % len(EDGE_TYPES)]
        edge_batch.append((eid, f"node-{a:07d}", f"node-{b:07d}", etype))
        e_idx += 1
        if len(edge_batch) >= BATCH_SIZE:
            cur.executemany("INSERT INTO edges VALUES (?,?,?,?)", edge_batch)
            conn.commit()
            edge_batch.clear()
            if e_idx % 100_000 == 0:
                print(f"    edges: {e_idx:,}", flush=True)
    if edge_batch:
        cur.executemany("INSERT INTO edges VALUES (?,?,?,?)", edge_batch)
        conn.commit()
    print(f"  Edges done in {(time.perf_counter()-t0)*1000:.0f}ms", flush=True)


def ensure_db(reset: bool) -> sqlite3.Connection:
    if reset and os.path.exists(DB_PATH):
        os.remove(DB_PATH)
        print("  Deleted existing DB (--reset)")
    if os.path.exists(DB_PATH):
        print("  Using cached DB (skip seeding)")
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        return conn
    print("  DB not found — seeding now …")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    seed_db(conn)
    return conn


# ---------------------------------------------------------------------------
# Method 1: Dump — plain Python dicts + adjacency list
# ---------------------------------------------------------------------------

def load_dump(conn: sqlite3.Connection):
    nodes = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM nodes")}
    out_edges: dict[str, list] = defaultdict(list)
    for row in conn.execute("SELECT id, from_id, to_id, type FROM edges"):
        out_edges[row["from_id"]].append((row["id"], row["to_id"], row["type"]))
    return nodes, out_edges


def _dump_build_cyto(nodes: dict, out_edges: dict, matched_ids: list[str]) -> CytoGraph:
    matched_set = set(matched_ids)
    node_elements = [
        _node_element(nid, nodes[nid]["type"], nodes[nid]["created_date"], nodes[nid]["data"])
        for nid in matched_ids
    ]
    edge_elements = [
        _edge_element(eid, nid, to_id, etype)
        for nid in matched_ids
        for eid, to_id, etype in out_edges.get(nid, [])
        if to_id in matched_set
    ]
    return _cyto(node_elements, edge_elements)


def dump_time_query(nodes, out_edges, t_start, t_end) -> CytoGraph:
    matched = [n["id"] for n in nodes.values() if t_start <= n["created_date"] <= t_end]
    return _dump_build_cyto(nodes, out_edges, matched)


def dump_tag_query(nodes, out_edges, target_tags) -> CytoGraph:
    ts = set(target_tags)
    matched = [n["id"] for n in nodes.values() if ts.intersection(json.loads(n["data"])["tags"])]
    return _dump_build_cyto(nodes, out_edges, matched)


def dump_text_query(nodes, out_edges, word) -> CytoGraph:
    w = word.lower()
    matched = [n["id"] for n in nodes.values() if w in json.loads(n["data"])["text"].lower()]
    return _dump_build_cyto(nodes, out_edges, matched)


# ---------------------------------------------------------------------------
# Method 2: SQL — CTE-based induced subgraph
# ---------------------------------------------------------------------------

def _sql_build_cyto(conn: sqlite3.Connection, node_cte_sql: str, params: list) -> CytoGraph:
    node_sql = f"""
    WITH matched(id) AS ({node_cte_sql})
    SELECT n.id, n.type, n.created_date, n.data FROM nodes n
    JOIN matched m ON n.id = m.id
    """
    rows = conn.execute(node_sql, params).fetchall()
    node_elements = [_node_element(r["id"], r["type"], r["created_date"], r["data"]) for r in rows]

    edge_sql = f"""
    WITH matched(id) AS ({node_cte_sql})
    SELECT e.id, e.from_id, e.to_id, e.type FROM edges e
    WHERE e.from_id IN (SELECT id FROM matched)
      AND e.to_id   IN (SELECT id FROM matched)
    """
    edge_rows = conn.execute(edge_sql, params).fetchall()
    edge_elements = [_edge_element(r["id"], r["from_id"], r["to_id"], r["type"]) for r in edge_rows]
    return _cyto(node_elements, edge_elements)


def sql_time_query(conn, t_start, t_end) -> CytoGraph:
    return _sql_build_cyto(conn, "SELECT id FROM nodes WHERE created_date BETWEEN ? AND ?", [t_start, t_end])


def sql_tag_query(conn, target_tags) -> CytoGraph:
    ph = ",".join("?" * len(target_tags))
    cte = f"SELECT n.id FROM nodes n WHERE EXISTS (SELECT 1 FROM json_each(json_extract(n.data, '$.tags')) WHERE value IN ({ph}))"
    return _sql_build_cyto(conn, cte, target_tags)


def sql_text_query(conn, word) -> CytoGraph:
    return _sql_build_cyto(conn, "SELECT id FROM nodes WHERE json_extract(data, '$.text') LIKE ?", [f"%{word}%"])


def sql_fts_query(conn, word) -> CytoGraph:
    return _sql_build_cyto(conn, "SELECT node_id AS id FROM nodes_fts WHERE text_body MATCH ?", [word])


# ---------------------------------------------------------------------------
# Method 3: NetworkX — DiGraph with G.subgraph() for induced edges
# ---------------------------------------------------------------------------

def load_networkx(conn: sqlite3.Connection) -> nx.DiGraph:
    G = nx.DiGraph()
    for row in conn.execute("SELECT * FROM nodes"):
        d = json.loads(row["data"])
        G.add_node(row["id"],
                   type=row["type"],
                   created_date=row["created_date"],
                   tags=d["tags"],
                   text=d["text"])
    for row in conn.execute("SELECT id, from_id, to_id, type FROM edges"):
        G.add_edge(row["from_id"], row["to_id"], id=row["id"], type=row["type"])
    return G


def _nx_build_cyto(G: nx.DiGraph, matched_ids: list[str]) -> CytoGraph:
    # G.subgraph() returns a read-only VIEW of the induced subgraph — O(1) construction
    sub = G.subgraph(matched_ids)
    node_elements = [
        {"data": {"id": n, "type": attrs["type"], "created_date": attrs["created_date"],
                  "tags": attrs["tags"], "text": attrs["text"]}}
        for n, attrs in sub.nodes(data=True)
    ]
    edge_elements = [
        {"data": {"id": attrs["id"], "source": u, "target": v, "type": attrs["type"]}}
        for u, v, attrs in sub.edges(data=True)
    ]
    return _cyto(node_elements, edge_elements)


def nx_time_query(G: nx.DiGraph, t_start, t_end) -> CytoGraph:
    matched = [n for n, d in G.nodes(data=True) if t_start <= d["created_date"] <= t_end]
    return _nx_build_cyto(G, matched)


def nx_tag_query(G: nx.DiGraph, target_tags) -> CytoGraph:
    ts = set(target_tags)
    matched = [n for n, d in G.nodes(data=True) if ts.intersection(d["tags"])]
    return _nx_build_cyto(G, matched)


def nx_text_query(G: nx.DiGraph, word) -> CytoGraph:
    w = word.lower()
    matched = [n for n, d in G.nodes(data=True) if w in d["text"].lower()]
    return _nx_build_cyto(G, matched)


# ---------------------------------------------------------------------------
# Timing + validation helpers
# ---------------------------------------------------------------------------

def timeit(fn, *args, **kwargs):
    t0 = time.perf_counter()
    result = fn(*args, **kwargs)
    return result, (time.perf_counter() - t0) * 1000


def validate(label: str, ref: CytoGraph, other: CytoGraph, other_name: str) -> bool:
    n_ok = cyto_node_ids(ref) == cyto_node_ids(other)
    e_ok = cyto_edge_ids(ref) == cyto_edge_ids(other)
    if not n_ok:
        a, b = cyto_node_ids(ref) - cyto_node_ids(other), cyto_node_ids(other) - cyto_node_ids(ref)
        print(f"  ✗ NODE MISMATCH [{label}] dump_only={len(a)} {other_name}_only={len(b)}")
    if not e_ok:
        a, b = cyto_edge_ids(ref) - cyto_edge_ids(other), cyto_edge_ids(other) - cyto_edge_ids(ref)
        print(f"  ✗ EDGE MISMATCH [{label}] dump_only={len(a)} {other_name}_only={len(b)}")
    return n_ok and e_ok


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--num-nodes", type=int, default=None)
    parser.add_argument("--num-edges", type=int, default=None)
    args = parser.parse_args()

    global NUM_NODES, NUM_EDGES, DB_PATH
    if args.num_nodes is not None:
        NUM_NODES = args.num_nodes
        args.reset = True
        DB_PATH = "/tmp/graph_benchmark_small.db"
    if args.num_edges is not None:
        NUM_EDGES = args.num_edges
        args.reset = True
        DB_PATH = "/tmp/graph_benchmark_small.db"

    scale_label = f"{NUM_NODES:,} nodes / {NUM_EDGES:,} edges"
    W = 68
    print("=" * W)
    print(f"  Graph Benchmark — {scale_label}")
    print(f"  Methods: Dump (dict) | SQL (CTE) | NetworkX (DiGraph)")
    print(f"  Output:  Cytoscape JSON — induced subgraph per query")
    print("=" * W)

    conn = ensure_db(args.reset)
    print(f"  DB size: {os.path.getsize(DB_PATH)/(1024*1024):.1f} MB")
    print("=" * W)
    print()

    # Load all three in-memory structures
    print("  Loading structures into memory …", flush=True)
    (nodes, out_edges), dump_load_ms = timeit(load_dump, conn)
    print(f"  Dump loaded in    {dump_load_ms:.0f}ms", flush=True)
    G, nx_load_ms = timeit(load_networkx, conn)
    print(f"  NetworkX loaded in {nx_load_ms:.0f}ms  ({G.number_of_nodes():,} nodes, {G.number_of_edges():,} edges)\n")

    results: dict[str, dict] = {}

    # -----------------------------------------------------------------------
    def run_query(label, dump_fn, dump_args, sql_fn, sql_args, nx_fn, nx_args):
        dg,  d_ms  = timeit(dump_fn, *dump_args)
        sg,  s_ms  = timeit(sql_fn,  *sql_args)
        ng,  n_ms  = timeit(nx_fn,   *nx_args)

        sql_ok = validate(label, dg, sg, "sql")
        nx_ok  = validate(label, dg, ng, "nx")

        dn, de = len(dg["elements"]["nodes"]), len(dg["elements"]["edges"])
        sn, se = len(sg["elements"]["nodes"]), len(sg["elements"]["edges"])
        nn, ne = len(ng["elements"]["nodes"]), len(ng["elements"]["edges"])

        results[label] = {"dump_ms": d_ms, "sql_ms": s_ms, "nx_ms": n_ms}

        print(f"  Query: {label}")
        print(f"  ├── Dump      query+cyto: {d_ms:6.0f}ms  ({dn:,} nodes, {de:,} edges)")
        print(f"  ├── SQL       query+cyto: {s_ms:6.0f}ms  ({sn:,} nodes, {se:,} edges)")
        print(f"  ├── NetworkX  query+cyto: {n_ms:6.0f}ms  ({nn:,} nodes, {ne:,} edges)")
        ok_str = "✓" if sql_ok and nx_ok else "✗ MISMATCH"
        print(f"  └── {ok_str} all results match (nodes + edges)")
        print()
        return dg, sg, ng

    # -----------------------------------------------------------------------
    t_mid   = (TS_START + TS_END) / 2
    q1_s, q1_e = t_mid - 30*24*3600, t_mid + 30*24*3600
    run_query(
        "Time Range (±30d)",
        dump_time_query, (nodes, out_edges, q1_s, q1_e),
        sql_time_query,  (conn, q1_s, q1_e),
        nx_time_query,   (G, q1_s, q1_e),
    )

    target_tags = ["tag3", "tag11"]
    run_query(
        f"Tag Filter {target_tags}",
        dump_tag_query, (nodes, out_edges, target_tags),
        sql_tag_query,  (conn, target_tags),
        nx_tag_query,   (G, target_tags),
    )

    search_word = "alpha"
    # text search: compare dump vs sql-substring for correctness; show FTS5 timing separately
    dump_q3, dump_q3_ms = timeit(dump_text_query, nodes, out_edges, search_word)
    sql_q3s, sql_q3s_ms = timeit(sql_text_query, conn, search_word)
    sql_q3f, sql_q3f_ms = timeit(sql_fts_query,  conn, search_word)
    nx_q3,   nx_q3_ms   = timeit(nx_text_query,  G, search_word)

    sub_ok = validate("Text substring", dump_q3, sql_q3s, "sql")
    nx_ok  = validate("Text substring", dump_q3, nx_q3,   "nx")
    dn3, de3   = len(dump_q3["elements"]["nodes"]),  len(dump_q3["elements"]["edges"])
    sn3s, se3s = len(sql_q3s["elements"]["nodes"]),  len(sql_q3s["elements"]["edges"])
    sn3f, se3f = len(sql_q3f["elements"]["nodes"]),  len(sql_q3f["elements"]["edges"])
    nn3,  ne3  = len(nx_q3["elements"]["nodes"]),    len(nx_q3["elements"]["edges"])

    results["Text search"] = {"dump_ms": dump_q3_ms, "sql_ms": sql_q3f_ms, "nx_ms": nx_q3_ms}

    print(f'  Query: Text Search ("{search_word}")')
    print(f"  ├── Dump      substring:  {dump_q3_ms:6.0f}ms  ({dn3:,} nodes, {de3:,} edges)")
    print(f"  ├── SQL       substring:  {sql_q3s_ms:6.0f}ms  ({sn3s:,} nodes, {se3s:,} edges)  [correctness ref]")
    print(f"  ├── SQL       FTS5:       {sql_q3f_ms:6.0f}ms  ({sn3f:,} nodes, {se3f:,} edges)")
    print(f"  ├── NetworkX  substring:  {nx_q3_ms:6.0f}ms  ({nn3:,} nodes, {ne3:,} edges)")
    ok_str = "✓" if sub_ok and nx_ok else "✗ MISMATCH"
    print(f"  ├── {ok_str} substring results match (nodes + edges)")
    print(f"  └── ℹ  FTS5 uses Porter stemming — shown for timing only")
    print()

    # -----------------------------------------------------------------------
    # Summary table
    # -----------------------------------------------------------------------
    def winner3(d, s, n) -> str:
        best_ms = min(d, s, n)
        best    = "Dump" if best_ms == d else ("SQL" if best_ms == s else "NX")
        ratio   = max(d, s, n) / best_ms if best_ms > 0 else float("inf")
        return f"{best} ({ratio:.1f}x faster)"

    c1, c2, c3, c4, c5 = 22, 10, 10, 10, 22
    top = f"  ┌{'─'*(c1+2)}┬{'─'*(c2+2)}┬{'─'*(c3+2)}┬{'─'*(c4+2)}┬{'─'*(c5+2)}┐"
    sep = f"  ├{'─'*(c1+2)}┼{'─'*(c2+2)}┼{'─'*(c3+2)}┼{'─'*(c4+2)}┼{'─'*(c5+2)}┤"
    bot = f"  └{'─'*(c1+2)}┴{'─'*(c2+2)}┴{'─'*(c3+2)}┴{'─'*(c4+2)}┴{'─'*(c5+2)}┘"

    def row(q, d, s, n, w):
        return f"  │ {q:<{c1}} │ {d:>{c2}} │ {s:>{c3}} │ {n:>{c4}} │ {w:<{c5}} │"

    print("=" * W)
    print("  SUMMARY  (query + cyto build, excluding load time)")
    print(top)
    print(row("Query", "Dump(ms)", "SQL(ms)", "NX(ms)", "Winner"))
    print(sep)
    for label, r in results.items():
        print(row(label, f"{r['dump_ms']:.0f}", f"{r['sql_ms']:.0f}", f"{r['nx_ms']:.0f}",
                  winner3(r["dump_ms"], r["sql_ms"], r["nx_ms"])))
    print(bot)
    print(f"  Load times (one-time):  Dump {dump_load_ms:.0f}ms  |  NetworkX {nx_load_ms:.0f}ms  |  SQL n/a")
    print("=" * W)

    conn.close()


if __name__ == "__main__":
    main()
