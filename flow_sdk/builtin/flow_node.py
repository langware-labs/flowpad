"""FlowNode — a station in the flow graph.

The durable identity that wires into topics: it holds the *program* (what to do
when an event arrives) and execution defaults. It never executes — executions
are separate AgenticProcess entities spawned per event (spawn mode) or a single
long-lived process events are injected into (inject mode), each related back to
this node.

DB-only entity (no ``asset_ref``). Wiring is relationship-based:
``Listens`` edges (declared, node → topic) and ``Emits`` edges (observed,
stamped by FlowManager). See ``flow_sdk/flow_manager/``.

NOTE: no ``from __future__ import annotations`` here — the graph action
dispatcher (server/routes/graph.py) binds handler args by inspecting runtime
annotations, and stringified annotations break ``request: Request`` binding.
"""
from typing import ClassVar, Optional, Union

from starlette.requests import Request

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.core import Entity
from flow_sdk.core import action as core_action
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.flowpad_types.enums.entity_enums import (
    BuiltInRelationshipTypes,
    RelationshipDirection,
)
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.types import EntityType


class ProgramKind(StrEnum):
    """What a FlowNode runs on delivery."""

    CALLBACK = "callback"          # trigger_callbacks registry name
    SKILL = "skill"                # skill name → spawned agent runs /<skill>
    INSTRUCTION = "instruction"    # raw instruction text → spawned agent


class DeliveryMode(StrEnum):
    SPAWN = "spawn"    # fresh AgenticProcess per event
    INJECT = "inject"  # prompt into the node's current live process


class ExecutionMode(StrEnum):
    """Concurrency policy for a node's executions (FlowManager scheduler)."""

    SERIAL = "serial"      # one execution at a time; excess events queue
    PARALLEL = "parallel"  # up to ``parallel_limit`` concurrent executions


# Model size → CLI model alias for spawned agent executions. Size names (not
# model ids) so the mapping can evolve without touching stored nodes.
MODEL_SIZE_TO_CLI = {
    "sm": "haiku",
    "md": "sonnet",
    "lg": "opus",
}


class FlowNode(Entity):
    type: str = APIField(default=EntityType.FLOW_NODE.value)
    name: str = APIField("")
    description: Optional[str] = APIField(None)
    program_kind: str = APIField(
        default=ProgramKind.CALLBACK.value,
        description="callback | skill | instruction",
    )
    program_ref: str = APIField(
        "",
        description="callback_name / skill name / instruction text, per program_kind.",
    )
    prompt: Optional[str] = APIField(
        None,
        description="Extra prompt appended to the program on delivery (skill args / task framing).",
    )
    model_size: str = APIField(
        default="sm",
        description="Model size for spawned agent executions: sm (haiku) | md (sonnet) | lg (opus).",
    )
    delivery_mode: str = APIField(
        default=DeliveryMode.SPAWN.value, description="spawn | inject"
    )
    workdir: Optional[str] = APIField(None, description="Working directory for spawned executions.")
    visible: bool = APIField(default=False, description="Whether spawned processes get a visible tab.")
    current_process_id: Optional[str] = APIField(
        None, description="Live AgenticProcess id (inject mode only)."
    )
    execution_mode: str = APIField(
        default=ExecutionMode.SERIAL.value,
        description="serial (one by one) | parallel (up to parallel_limit concurrent)",
    )
    parallel_limit: int = APIField(
        default=3, description="Max concurrent executions when execution_mode=parallel."
    )
    merge_identical: bool = APIField(
        default=False,
        description="Drop an incoming event if an identical one (same topic+payload) is already pending in the queue.",
    )
    enabled: bool = APIField(default=True)

    _api_visible: ClassVar[bool] = True

    # ── Wiring (bipartite: node ↔ topic only) ─────────────────────────────────

    async def listen(self, topic: Union[Entity, TypeId]) -> None:
        """Declare a subscription: this node hears the topic's whole subtree."""
        if isinstance(topic, Entity):
            topic = topic.typeid
        await self.save_relationship(
            to_e=topic,
            relationship_or_str=BuiltInRelationshipTypes.Listens,
            direction=RelationshipDirection.Outgoing,
        )

    async def unlisten(self, topic: Union[Entity, TypeId]) -> None:
        # Pass a typed relationship instance: the delete-by-match path calls the
        # CLASS-level get_type(), so a generic Relationship(type="listens")
        # would match nothing (it deletes as type "relationship").
        from flow_sdk.db.relationship_model import ListensRelationship

        if isinstance(topic, Entity):
            topic = topic.typeid
        await self.delete_relationship(to_e=topic, relationship=ListensRelationship())

    async def listened_topics(self) -> list[TypeId]:
        rels = await self.get_outgoing_relationships(
            relationships_filter=QueryFilter(type=BuiltInRelationshipTypes.Listens)
        )
        return [rel.to_typeid for rel in rels if rel.to_typeid]

    # ── API actions ───────────────────────────────────────────────────────────

    @core_action.post(action_name="wire")
    async def wire_action(self, request: Request) -> ApiResponse:
        """POST /api/v1/graph/flow_node/{id}/wire — declare/remove a Listens edge.

        Body: ``{"topic_id": <id>}`` or ``{"topic_name": "a.b"}`` (minted if
        absent), plus optional ``"op": "add" | "remove"`` (default add).
        """
        from flow_sdk.builtin.topic import Topic

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        body = body or {}
        topic = None
        if body.get("topic_id"):
            topic = await Topic.get_by_id(body["topic_id"])
            if topic is None:
                return ApiFailResponse(message=f"Topic {body['topic_id']} not found")
        elif body.get("topic_name"):
            try:
                topic = await Topic.get_or_mint(body["topic_name"])
            except ValueError as e:
                return ApiFailResponse(message=str(e))
        if topic is None:
            return ApiFailResponse(message="topic_id or topic_name required")

        if (body.get("op") or "add") == "remove":
            await self.unlisten(topic)
        else:
            await self.listen(topic)
        return ApiSuccessResponse(data={"node_id": self.id, "topic": topic.name})
