"""Server-owned projection of the messages belonging to one Agent inbox.

An Agent's inbox is the rows it OWNS — sources, threads, conversations carry
an ``owner`` — so this is a filter, not a walk from one provider."""

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
    """The local rows an Agent's inbox is made of."""

    agent_id: str
    source_id: str | None
    #: Every message source the agent owns; ``source_id`` is the first of them,
    #: kept for the callers that predate an agent holding more than one.
    source_ids: frozenset[str] = frozenset()
    source_item_ids: frozenset[str] = frozenset()
    flow_message_ids: frozenset[str] = frozenset()
    thread_ids: frozenset[str] = frozenset()
    conversation_ids: frozenset[str] = frozenset()

    def as_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "source_id": self.source_id,
            "source_ids": sorted(self.source_ids),
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


def is_message_source(source) -> bool:
    """The domain predicate: a DataSource on a channel whose driver can send."""
    from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

    if not (getattr(source, "channel", "") or "").strip():
        return False
    driver = get_driver(getattr(source, "provider", "") or "")
    return bool(driver is not None and getattr(driver, "sends", False))


async def resolve_agent_inbox_scope(agent_id: str) -> AgentInboxScope:
    """The rows in an Agent's inbox — a filter on ``owner``, not a walk.

    An Agent's message sources are the ones it OWNS (``DataSource.find_owned``,
    which also resolves rows written before ``owner`` existed). Its
    conversations and threads are the ones stamped with its owner, unioned
    with the ones its sources' messages point at — the second set is what the
    pre-owner walk returned, kept so the answer is a superset by construction
    and never loses a row the backfill has not reached. ``flow_message_ids``
    stays derived from the sources' items: the set of messages IN an
    agent-owned conversation is not provably the same set (the agent's own
    turn may write rows that are not source-backed), and the inbox list keys
    on this one.
    """
    import flow_sdk.ingest.drivers  # noqa: F401, PLC0415 — register drivers
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.message_thread import MessageThread  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    agent_id = str(agent_id or "").strip()
    if not is_valid_entity_id(agent_id):
        raise AgentInboxScopeError("Invalid Agent id", status_code=400)
    if await Agent.get_one({"id": agent_id}) is None:
        raise AgentInboxScopeError("Agent not found")

    owner = TypeId(type=EntityType.AGENT.value, id=agent_id)
    sources = sorted(
        (s for s in await DataSource.find_owned(owner) if is_message_source(s)),
        key=lambda s: str(s.id),
    )
    source_ids = [str(s.id) for s in sources]

    item_ids: set[str] = set()
    for source_id in source_ids:
        items = await SourceItem.get_all({"data_source_id": source_id})
        item_ids.update(str(item.id) for item in items)
    messages = []
    if item_ids:
        messages = await FlowMessage.get_all(
            QueryFilter(match=ExpressionNode(op=QueryOp.IN, operands=["source_item_id", sorted(item_ids)])),
            hydrate=False,
        )
    thread_ids = {str(m.thread_id) for m in messages if m.thread_id}
    conversation_ids = {str(m.conversation_id) for m in messages if m.conversation_id}
    thread_ids.update(str(t.id) for t in await MessageThread.get_all({"owner": str(owner)}))
    conversation_ids.update(str(c.id) for c in await Conversation.get_all({"owner": str(owner)}))

    return AgentInboxScope(
        agent_id=agent_id,
        source_id=source_ids[0] if source_ids else None,
        source_ids=frozenset(source_ids),
        source_item_ids=frozenset(item_ids),
        flow_message_ids=frozenset(str(m.id) for m in messages),
        thread_ids=frozenset(thread_ids),
        conversation_ids=frozenset(conversation_ids),
    )


__all__ = ["AgentInboxScope", "AgentInboxScopeError", "resolve_agent_inbox_scope"]
