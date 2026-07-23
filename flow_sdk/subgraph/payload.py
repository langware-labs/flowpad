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


def validate_payload(data: dict[str, Any]) -> list[str]:
    """Structural problems in a built payload, as human-readable strings.

    Leniency about node identity (ghosts carry natural-key ids) cost us the
    integrity checks the strict worldview model performs, so they live here
    instead: unique node keys, no dangling edge endpoints, honest counts.
    Builders are trusted at runtime; tests assert this is empty.
    """
    problems: list[str] = []
    nodes = data.get("nodes") or []
    edges = data.get("edges") or []

    keys: set[str] = set()
    for item in nodes:
        key = node_key(item["type"], item["id"])
        if key in keys:
            problems.append(f"duplicate node key: {key}")
        keys.add(key)

    for item in edges:
        for side in ("from", "to"):
            endpoint = item[side]
            key = node_key(endpoint["type"], endpoint["id"])
            if key not in keys:
                problems.append(f"edge {side} endpoint has no node: {key}")

    counts = data.get("counts") or {}
    if counts.get("nodes") != len(nodes) or counts.get("edges") != len(edges):
        problems.append("counts do not match the node/edge lists")

    root = data.get("root")
    if root is not None and root not in keys:
        problems.append(f"root is not a node in the payload: {root}")
    return problems
