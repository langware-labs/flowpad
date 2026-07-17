"""The flow document — ``graph.json``, the semantic truth of an AgenticFlow.

An AgenticFlow folder holds:

    .claude/agentic-flows/<name>/
        graph.json      # THIS document — nodes + edges (+ the entity id)
        display.json    # presentation only (positions/colors) — never parsed here
        scripts/        # pysdk node files
        runs/           # execution journals (one JSONL per run)

Model (version 1):

* ``FlowNodeDef`` — ``node_type`` is one of:
    - ``trigger``        — entity-ref to a Trigger (``node_data.typeid``);
                           output-only (emits ``fired``), no inputs.
    - ``process_runner`` — an agent/callback station (program fields).
    - ``pysdk``          — a python file run per event (``node_data.script``).
* ``FlowEdgeDef`` — ``{from: {node, event}, to: {node}}``. Events are LOCAL to
  the flow; ``event == "*"`` is a catch-all matching any emitted key.

Routing consumes this document directly (disk is the source of truth); the DB
holds only derived record-keeping rows.
"""
from __future__ import annotations

import json
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

CATCH_ALL_EVENT = "*"
TRIGGER_FIRED_EVENT = "fired"
AGENT_DONE_EVENT = "done"

NodeType = Literal["trigger", "process_runner", "pysdk"]


class FlowNodeDef(BaseModel):
    id: str
    node_type: NodeType
    name: str = ""
    node_data: dict[str, Any] = Field(default_factory=dict)


class EdgeEndpoint(BaseModel):
    node: str
    event: str = CATCH_ALL_EVENT


class FlowEdgeDef(BaseModel):
    id: str
    from_: EdgeEndpoint = Field(alias="from")
    to: dict[str, str]  # {"node": <id>}

    model_config = {"populate_by_name": True}

    @property
    def to_node(self) -> str:
        return self.to.get("node", "")


class FlowDoc(BaseModel):
    version: int = 1
    id: Optional[str] = None  # the AgenticFlow entity id (adopted by gen_uuid)
    name: str = ""
    description: str = ""
    enabled: bool = True  # the flow's active switch
    nodes: list[FlowNodeDef] = Field(default_factory=list)
    edges: list[FlowEdgeDef] = Field(default_factory=list)

    @field_validator("version")
    @classmethod
    def _version_supported(cls, v: int) -> int:
        if v != 1:
            raise ValueError(f"Unsupported graph.json version: {v}")
        return v

    # ── lookups ───────────────────────────────────────────────────────────────

    def node(self, node_id: str) -> Optional[FlowNodeDef]:
        return next((n for n in self.nodes if n.id == node_id), None)

    def targets_for(self, source_node: str, event: str) -> list[FlowNodeDef]:
        """Edge routing: exact event match or catch-all, within this flow."""
        out: list[FlowNodeDef] = []
        for e in self.edges:
            if e.from_.node != source_node:
                continue
            if e.from_.event != event and e.from_.event != CATCH_ALL_EVENT:
                continue
            target = self.node(e.to_node)
            if target is not None:
                out.append(target)
        return out

    def trigger_nodes(self) -> list[FlowNodeDef]:
        return [n for n in self.nodes if n.node_type == "trigger"]

    def trigger_ids(self) -> list[str]:
        """Trigger ENTITY ids referenced by this flow's trigger nodes."""
        ids: list[str] = []
        for n in self.trigger_nodes():
            typeid = str(n.node_data.get("typeid") or "")
            if typeid.startswith("trigger-"):
                ids.append(typeid[len("trigger-"):])
        return ids

    def trigger_nodes_for(self, trigger_id: str) -> list[FlowNodeDef]:
        """Trigger nodes referencing the given Trigger ENTITY id — the ONE
        matcher for trigger→node resolution (exact id, never a suffix match)."""
        prefix = "trigger-"
        return [
            n for n in self.trigger_nodes()
            if str(n.node_data.get("typeid") or "") == f"{prefix}{trigger_id}"
        ]

    def validate_graph(self) -> list[str]:
        """Structural problems (non-fatal — callers decide). Returns messages."""
        problems: list[str] = []
        ids = [n.id for n in self.nodes]
        if len(ids) != len(set(ids)):
            problems.append("duplicate node ids")
        known = set(ids)
        for e in self.edges:
            if e.from_.node not in known:
                problems.append(f"edge {e.id}: unknown source node {e.from_.node}")
            if e.to_node not in known:
                problems.append(f"edge {e.id}: unknown target node {e.to_node}")
            src = self.node(e.from_.node)
            if src is not None and src.node_type == "trigger" and e.from_.event not in (
                TRIGGER_FIRED_EVENT, CATCH_ALL_EVENT,
            ):
                problems.append(f"edge {e.id}: trigger nodes only emit '{TRIGGER_FIRED_EVENT}'")
        for e in self.edges:
            target = self.node(e.to_node)
            if target is not None and target.node_type == "trigger":
                problems.append(f"edge {e.id}: trigger nodes accept no inputs")
        return problems


def parse_flow_doc(text: str) -> FlowDoc:
    """Parse + validate graph.json content. Raises ValueError on bad JSON/schema."""
    try:
        payload = json.loads(text or "{}")
    except json.JSONDecodeError as e:
        raise ValueError(f"graph.json is not valid JSON: {e}") from e
    return FlowDoc.model_validate(payload)


def empty_flow_doc(flow_id: str, name: str = "") -> str:
    """Stub graph.json content for a freshly scaffolded flow."""
    return json.dumps(
        {"version": 1, "id": flow_id, "name": name, "enabled": True, "nodes": [], "edges": []},
        indent=2,
    ) + "\n"
