"""The flow document — ``graph.json``, the semantic truth of an AgenticFlow.

An AgenticFlow folder holds:

    .claude/agentic-flows/<name>/
        graph.json      # THIS document — nodes + edges + config (+ the entity id)
        display.json    # presentation only (positions/colors) — never parsed here
        scripts/        # function node scripts (subprocess runtime)
        runs/           # execution journals (one JSONL per run)

Model (version 1):

* ``FlowNodeDef`` — ``node_type`` is one of:
    - ``trigger``  — entity-ref to a Trigger (``node_data.typeid``);
                     output-only (emits ``fired``), no inputs.
    - ``agent``    — a spawned worker station (``program_kind: skill|instruction``,
                     ``program_ref``, ``prompt``, ``model_size``, scheduler knobs).
    - ``function`` — a FlowFunction (``node_data.function`` = registry name or
                     ``scripts/<file>.py``; ``node_data.runtime`` = ``inline`` |
                     ``subprocess``). One contract everywhere:
                     ``on_flow_event(event_name, data, flow_ctx)``.
* ``FlowEdgeDef`` — ``{from: {node, event}, to: {node}}``. Events are LOCAL to
  the flow; ``event == "*"`` is a catch-all matching any emitted key.
* ``config`` — per-flow knobs: run retention + loop budgets.

Routing consumes this document directly (disk is the source of truth); the DB
holds only derived record-keeping rows.
"""
from __future__ import annotations

import json
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

CATCH_ALL_EVENT = "*"
TRIGGER_FIRED_EVENT = "fired"
AGENT_DONE_EVENT = "done"

NodeType = Literal["trigger", "agent", "function"]
FunctionRuntime = Literal["inline", "subprocess"]

# Retired spellings → the pointed message users get instead of a pydantic enum error.
_RETIRED_NODE_TYPES = {
    "pysdk": 'node_type "pysdk" was retired — use node_type "function" with '
             'node_data {"function": "scripts/<file>.py", "runtime": "subprocess"}',
    "process_runner": 'node_type "process_runner" was renamed — use node_type "agent" '
                      '(callback programs moved to node_type "function", runtime "inline")',
}


def retired_node_shape(node: dict) -> str | None:
    """THE owner of "what is a retired node spelling": the pointed message for a
    raw node dict on a pre-FlowFunction shape, or None. The parse validator
    raises it; the seed migration detects with it — one set, two consumers."""
    if not isinstance(node, dict):
        return None
    msg = _RETIRED_NODE_TYPES.get(str(node.get("node_type") or ""))
    if msg:
        return msg
    if str((node.get("node_data") or {}).get("program_kind") or "") == "callback":
        return ('program_kind "callback" was retired — use node_type "function" with '
                'node_data {"function": "<registry name>", "runtime": "inline"}')
    return None


class FlowConfig(BaseModel):
    """Per-flow knobs. Defaults mirror the historical module constants."""

    retention_runs: int = 5     # keep the newest N runs' records/journals
    max_hops: int = 16          # per-run event-hop budget (cycle guard)
    max_processes: int = 10     # per-run spawned-process budget
    deadline_s: int = 600       # per-run wall-clock budget


class FlowNodeDef(BaseModel):
    id: str
    node_type: NodeType
    name: str = ""
    node_data: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def _reject_retired_spellings(cls, data: Any) -> Any:
        if isinstance(data, dict):
            retired = retired_node_shape(data)
            if retired:
                raise ValueError(retired)
        return data

    def function_runtime(self) -> str:
        """A function node's effective runtime: explicit, else derived from the
        reference (``.py`` path → subprocess; registry name → inline)."""
        explicit = str(self.node_data.get("runtime") or "")
        if explicit:
            return explicit
        return "subprocess" if str(self.node_data.get("function") or "").endswith(".py") else "inline"


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
    config: FlowConfig = Field(default_factory=FlowConfig)
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
        """Trigger ENTITY ids referenced by this flow's trigger nodes — parsed
        through the canonical TypeId grammar, never a hand prefix-strip."""
        ids: list[str] = []
        for n in self.trigger_nodes():
            parsed = _parse_trigger_ref(n)
            if parsed:
                ids.append(parsed)
        return ids

    def trigger_nodes_for(self, trigger_id: str) -> list[FlowNodeDef]:
        """Trigger nodes referencing the given Trigger ENTITY id — the ONE
        matcher for trigger→node resolution (exact id, never a suffix match)."""
        return [n for n in self.trigger_nodes() if _parse_trigger_ref(n) == trigger_id]

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
        for n in self.nodes:
            if n.node_type != "function":
                continue
            ref = str(n.node_data.get("function") or "")
            if not ref:
                problems.append(f"node {n.id}: function nodes need node_data.function")
                continue
            runtime = n.function_runtime()
            if runtime not in ("inline", "subprocess"):
                problems.append(f"node {n.id}: unknown runtime {runtime!r}")
            if runtime == "inline" and ref.endswith(".py"):
                problems.append(
                    f"node {n.id}: flow-folder code never runs in the server process — "
                    'script functions require runtime "subprocess"'
                )
        return problems


def _parse_trigger_ref(node: FlowNodeDef) -> str | None:
    """A trigger node's referenced Trigger ENTITY id, via the TypeId grammar."""
    raw = str(node.node_data.get("typeid") or "")
    if not raw:
        return None
    try:
        from flow_sdk.api.type_id import TypeId

        tid = TypeId(raw)
    except Exception:
        return None
    return tid.id if tid.type == "trigger" else None


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
