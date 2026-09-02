"""Server-owned projection of the messages belonging to one Agent inbox."""

from __future__ import annotations

from dataclasses import dataclass

from flow_sdk.api.api_types.identifier import is_valid_entity_id


class AgentInboxScopeError(ValueError):
    """The requested Agent inbox scope cannot be resolved or does not own a target."""

    def __init__(self, message: str, *, status_code: int = 404):
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class AgentInboxScope:
    """The local rows reached through Agent -> cloud_email DataSource."""

    agent_id: str
    source_id: str | None
    source_item_ids: frozenset[str]
    flow_message_ids: frozenset[str]
    thread_ids: frozenset[str]
    conversation_ids: frozenset[str]

    def as_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "source_id": self.source_id,
            "flow_message_ids": sorted(self.flow_message_ids),
            "thread_ids": sorted(self.thread_ids),
            "conversation_ids": sorted(self.conversation_ids),
        }

    def require_message(self, flow_message_id: str) -> None:
        if flow_message_id not in self.flow_message_ids:
            raise AgentInboxScopeError("FlowMessage is not in this Agent inbox")

    def require_conversation(self, conversation_id: str) -> None:
        if conversation_id not in self.conversation_ids:
            raise AgentInboxScopeError("Conversation is not in this Agent inbox")


async def resolve_agent_inbox_scope(agent_id: str) -> AgentInboxScope:
    """Resolve an Agent's inbox rows from persisted natural-key relationships."""
    import flow_sdk.ingest.drivers  # noqa: F401, PLC0415 — register cloud_email
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver  # noqa: PLC0415

    agent_id = str(agent_id or "").strip()
    if not is_valid_entity_id(agent_id):
        raise AgentInboxScopeError("Invalid Agent id", status_code=400)
    if await Agent.get_one({"id": agent_id}) is None:
        raise AgentInboxScopeError("Agent not found")

    source = await DataSource.find_for_account(
        CloudEmailDriver.provider,
        CloudEmailDriver.identity_config_key,
        agent_id,
    )
    if source is None:
        return AgentInboxScope(
            agent_id=agent_id,
            source_id=None,
            source_item_ids=frozenset(),
            flow_message_ids=frozenset(),
            thread_ids=frozenset(),
            conversation_ids=frozenset(),
        )

    items = await SourceItem.get_all({"data_source_id": source.id})
    item_ids = frozenset(str(item.id) for item in items)
    messages = []
    if item_ids:
        messages = await FlowMessage.get_all(
            QueryFilter(
                match=ExpressionNode(
                    op=QueryOp.IN,
                    operands=["source_item_id", sorted(item_ids)],
                )
            ),
            hydrate=False,
        )

    return AgentInboxScope(
        agent_id=agent_id,
        source_id=str(source.id),
        source_item_ids=item_ids,
        flow_message_ids=frozenset(str(message.id) for message in messages),
        thread_ids=frozenset(str(message.thread_id) for message in messages if message.thread_id),
        conversation_ids=frozenset(
            str(message.conversation_id) for message in messages if message.conversation_id
        ),
    )


__all__ = ["AgentInboxScope", "AgentInboxScopeError", "resolve_agent_inbox_scope"]
