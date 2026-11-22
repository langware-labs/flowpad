"""``ConversationsSource`` — the hub conversations an agent's Identity is a member of, as a message source.

A person adds an agent's deployment to an ordinary hub conversation; the deployment's machine is
signed in to the hub as the agent's Identity, so the conversation is one that login can read. The
source is ONE stream over every such conversation: the hub's conversation list says which moved, a
conversation's messages are the records, a reply is ``add_message``. The deployment's serve loop
answers it like any other channel.

**Only as an agent.** A person's login reads the person's own conversations, which are never an
agent's to answer: signed out, or signed in as a person, the source reads nothing and sends nothing.

**Only plain conversations.** A help-desk ticket, an IT message and a monitoring channel are each
another kind of conversation with a source or a writer of its own; they are skipped.

**Every member may write.** The hub admitted each member of a conversation, so the source admits
any sender (``open_inbound``); the agent's own messages are told apart by its Identity (``whoami``).

One source per deployment: its config names the deployment that answers it.
"""

from __future__ import annotations

from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import Rejected
from flow_sdk.sources.hub_conversations import AppHub, HubConversationSource, PoolEntry, change_token, newest_first

#: The channel these conversations are: half the thread key.
CHANNEL = "conversations"
#: The hub's kind for an ordinary 1:1 or group conversation, and what a row that names no kind is.
DIRECT = "direct"


class ConversationsConfig(SourceConfig):
    """Which deployment's agent login this source reads as."""

    deployment_id: str


class ConversationsSource(HubConversationSource):
    Config = ConversationsConfig
    provider = "conversations"
    origin_kind = CHANNEL
    cursor_prefix = "conversations:"
    identity_config_key = "deployment_id"
    #: The hub admitted every member of a conversation: an empty allowlist admits each of them.
    open_inbound = True

    @classmethod
    def build(cls, binding: SourceBinding) -> "ConversationsSource":
        return cls(binding, hub=AppHub())

    def signed_in_as(self) -> str:
        return self.hub.agent()

    def require_ready(self) -> None:
        if not self.signed_in_as():
            raise Rejected(
                "This source reads conversations only as an agent: sign this machine in to Flowpad Cloud "
                "as the agent's Identity."
            )

    async def prepare_answer(self, conversation: str) -> None:
        self.require_ready()

    async def _read_pool(self) -> list[PoolEntry]:
        """Every plain conversation the agent's login can read, newest activity first."""
        self.require_ready()
        pool = []
        for row in await self.hub.walk("conversation"):
            conversation = str(row.get("id") or "").strip()
            if not conversation or row.get("deleted_at") or str(row.get("kind") or DIRECT) != DIRECT:
                continue
            updated_at = str(row.get("updated_date") or "")
            pool.append(
                PoolEntry(conversation, change_token(row.get("message_count"), updated_at, row.get("status")), updated_at)
            )
        return newest_first(pool)


__all__ = ["CHANNEL", "ConversationsSource"]
