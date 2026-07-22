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
    - ``agent``    — a spawned worker station. Preferably REFERENCES an Agent
                     definition entity (``node_data.typeid = "agent-<id>"`` —
                     model/tools/system prompt live on the definition, like
                     trigger→Trigger); inline fields (``program_kind:
                     skill|instruction``, ``program_ref``, ``prompt``,
                     ``model_size``) act as overrides, or stand alone for an
                     anonymous ad-hoc agent.
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
# The virtual source for external injections (mirror of envelope.EXTERNAL_SOURCE
# — kept literal here so the document model stays import-light).
EXTERNAL_SOURCE_NODE = "$external"
TRIGGER_FIRED_EVENT = "fired"
AGENT_DONE_EVENT = "done"

NodeType = Literal["trigger", "agent", "function", "guided_step"]
FunctionRuntime = Literal["inline", "subprocess"]

# guided_step — a human-in-the-loop node (User Journeys). It PRESENTS a place in
# the app (a standard dock pointer + optional wiki-word highlight), then PARKS the
# run waiting for a standard signal (dock reached / entity query / process status)
# that the frontend orchestrator observes; when satisfied the orchestrator injects
# this node's `done`, routed onward by the ordinary edge machinery. No new viewer,
# no DOM interception — pure guidance/orchestration over standard surfaces.
GUIDED_PRESENT_KINDS = {"asset_editor", "wiki", "home", "asset_list", "root"}
# What a guided step can do FOR the user, offered as a button on the step.
GUIDED_ACT_KINDS = {"fill"}
# The await side is a unified-bus subscription (docs/topics.md): `topic` names
# the awaited event (`app.page.signal`, `app.route.loaded`, `app.entity.created`,
# or `manual` for Continue-only), `target`/`vfs`/`home` filter it, and an
# optional `confirm` store-query proves it (event ≠ proof). The engine only
# requires the topic — the frontend JourneyManager owns the semantics.

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
    # Subscription-entry storm cap (runs started by the subscriptions: block,
    # per minute). Bounds cross-flow ping-pong loops the self-brake can't see
    # (A→B→A chains mint fresh envelopes every hop). One warn per window.
    max_entries_per_minute: int = 30


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


class FlowSubscriptionDef(BaseModel):
    """A graph-level unified-bus subscription (docs/flow-events.md phase 5):
    a matching FlowEvent starts a FRESH run — entry event ``event`` (default:
    the bus topic string), ``data = {topic, target, data}``, delivered to
    ``node`` directly when set, else edge-routed from ``$external``."""

    id: str = ""
    pattern: str
    target: Optional[str] = None
    scope: list[str] = Field(default_factory=list)
    # Entry event name inside the flow; defaults to the bus topic.
    event: Optional[str] = None
    # Direct-delivery node (bypasses edge routing), like inject's target_node.
    node: Optional[str] = None


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
    subscriptions: list[FlowSubscriptionDef] = Field(default_factory=list)
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
            # $external is a legal virtual SOURCE (inject-fed edges), never a node.
            if e.from_.node not in known and e.from_.node != EXTERNAL_SOURCE_NODE:
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
        for sub in self.subscriptions:
            # The topics-owned bus-pattern grammar gate (same rule as TOPIC
            # triggers — one owner, right dependency direction).
            from flow_sdk.topics import validate_bus_pattern

            problem = validate_bus_pattern(sub.pattern)
            if problem:
                problems.append(f"subscription {sub.id or sub.pattern!r}: {problem}")
            if sub.node and sub.node not in known:
                problems.append(f"subscription {sub.id or sub.pattern!r}: unknown node {sub.node}")
        for n in self.nodes:
            if n.node_type == "agent":
                nd = n.node_data
                if not (nd.get("typeid") or nd.get("program_ref") or nd.get("prompt")):
                    problems.append(
                        f"node {n.id}: agent nodes need an Agent reference (typeid) "
                        "or an inline program (program_ref / prompt)"
                    )
                continue
            if n.node_type == "guided_step":
                nd = n.node_data
                present = nd.get("present") or {}
                # A dock is OPTIONAL: a step may highlight in place (moving the
                # user off the surface they must click would defeat it), or
                # present nothing at all and just wait. Only the kind is checked,
                # and only when a dock is actually given.
                dock = present.get("dock")
                if dock is not None and dock.get("kind") not in GUIDED_PRESENT_KINDS:
                    problems.append(
                        f"node {n.id}: guided_step present.dock.kind must be "
                        f"in {sorted(GUIDED_PRESENT_KINDS)}"
                    )
                await_spec = nd.get("await") or {}
                topic = await_spec.get("topic")
                if not isinstance(topic, str) or not topic:
                    problems.append(
                        f"node {n.id}: guided_step needs node_data.await.topic "
                        "(a non-empty bus topic string, e.g. 'app.page.signal', or 'manual')"
                    )
                # `act` — what the journey OFFERS to do for the user (a step
                # button, not an automatic side effect). It aims at a topic word
                # like `present.highlight` does, so a missing target is dead.
                act = nd.get("act")
                if act is not None:
                    if act.get("kind") not in GUIDED_ACT_KINDS:
                        problems.append(
                            f"node {n.id}: guided_step act.kind must be in {sorted(GUIDED_ACT_KINDS)}"
                        )
                    if not (act.get("target") or "").strip():
                        problems.append(
                            f"node {n.id}: guided_step act needs a target (a topic word, "
                            "e.g. 'AgentInstructions')"
                        )
                continue
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


def _parse_entity_ref(node: FlowNodeDef, expected_type: str) -> str | None:
    """A node's referenced ENTITY id (``node_data.typeid``), via the canonical
    TypeId grammar — the one matcher for node→entity references (trigger nodes
    → Trigger, agent nodes → Agent). Garbage refs parse to None, never a
    partial match."""
    raw = str(node.node_data.get("typeid") or "")
    if not raw:
        return None
    try:
        from flow_sdk.api.type_id import TypeId

        tid = TypeId(raw)
    except Exception:
        return None
    return tid.id if tid.type == expected_type else None


def _parse_trigger_ref(node: FlowNodeDef) -> str | None:
    return _parse_entity_ref(node, "trigger")


def agent_ref(node: FlowNodeDef) -> str | None:
    """An agent node's referenced Agent ENTITY id (the definition), or None
    for a purely inline agent node."""
    return _parse_entity_ref(node, "agent")


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
