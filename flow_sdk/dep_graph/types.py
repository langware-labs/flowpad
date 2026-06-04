from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from flow_sdk._compat import StrEnum


class EdgeKind(StrEnum):
    CHILD = "child"
    CONTEXT_SHARED = "context_shared"
    CONTEXT_PRIVATE = "context_private"


@dataclass(frozen=True)
class Node:
    type: str
    id: str
    label: str | None = None
    is_ghost: bool = False

    @property
    def key(self) -> str:
        return f"{self.type}-{self.id}"


@dataclass(frozen=True)
class Edge:
    from_type: str
    from_id: str
    to_type: str
    to_id: str
    kind: EdgeKind

    def to_dict(self) -> dict[str, Any]:
        return {
            "from": {"type": self.from_type, "id": self.from_id},
            "to":   {"type": self.to_type,   "id": self.to_id},
            "kind": self.kind.value,
        }


@dataclass
class DepGraphResult:
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    duration_ms: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "nodes": [
                {"type": n.type, "id": n.id, "label": n.label,
                 "is_ghost": n.is_ghost, "key": n.key}
                for n in self.nodes
            ],
            "edges": [e.to_dict() for e in self.edges],
            "counts": {"nodes": len(self.nodes), "edges": len(self.edges)},
            "duration_ms": self.duration_ms,
        }
