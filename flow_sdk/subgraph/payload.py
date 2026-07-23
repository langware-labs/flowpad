"""GraphPayload shape helpers — keep builders from misspelling wire keys.

The wire contract is what ``ui/src/components/graph-view/graph/loadDepGraph.ts``
``graphFromPayload`` consumes:

    {"schema_version": 1, "projection": str, "root": str|None,
     "nodes": [{"type","id","label"?,"is_ghost"?,"properties"?}],
     "edges": [{"from":{"type","id"},"to":{"type","id"},"kind","topology"}],
     "counts": {"nodes": int, "edges": int}}

CONTRACT NOTE: edge endpoints resolve to node keys as ``<type>-<id>``
(``endpointKey``) — the optional node ``key`` override is NOT addressable by
edges. Therefore every node a subgraph wants edges on MUST be identified by
its (type, id) pair; ghosts use a stable natural id there (a topic name, a
relative path), never a custom key. ``root`` is a node key (``<type>-<id>``).
"""
from __future__ import annotations

from typing import Any, Optional


def node_key(type: str, id: str) -> str:
    """The frontend's endpointKey form — the one true node address."""
    return f"{type}-{id}"


def node(
    type: str,
    id: str,
    *,
    label: Optional[str] = None,
    is_ghost: bool = False,
    properties: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"type": type, "id": id}
    if label is not None:
        out["label"] = label
    if is_ghost:
        out["is_ghost"] = True
    if properties:
        out["properties"] = properties
    return out


def edge(
    from_type: str,
    from_id: str,
    to_type: str,
    to_id: str,
    *,
    kind: str,
    topology: str = "association",
) -> dict[str, Any]:
    return {
        "from": {"type": from_type, "id": from_id},
        "to": {"type": to_type, "id": to_id},
        "kind": kind,
        "topology": topology,
    }


def payload(
    projection: str,
    nodes: list[dict],
    edges: list[dict],
    *,
    root: Optional[str] = None,
) -> dict[str, Any]:
    """``root`` is a node key (``<type>-<id>``) or None."""
    return {
        "schema_version": 1,
        "projection": projection,
        "root": root,
        "nodes": nodes,
        "edges": edges,
        "counts": {"nodes": len(nodes), "edges": len(edges)},
    }
