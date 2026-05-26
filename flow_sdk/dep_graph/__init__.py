"""Dependency graph — context + child entity walker into a separate SQLite db.

Storage is intentionally isolated from the main flow.db: a separate sqlite file
at ``<instance_dir>/dep_graph.db`` with two tables (``dep_nodes``, ``dep_edges``).
The whole file is treated as a rebuildable index — drop and re-run
``build_dep_graph()`` at any time.
"""

from .types import Node, Edge, EdgeKind, DepGraphResult
from .db import dep_graph_db_path, open_dep_graph_db, init_schema
from .builder import build_dep_graph, load_graph

__all__ = [
    "Node",
    "Edge",
    "EdgeKind",
    "DepGraphResult",
    "dep_graph_db_path",
    "open_dep_graph_db",
    "init_schema",
    "build_dep_graph",
    "load_graph",
]
