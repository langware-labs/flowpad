"""``ConversationsSource`` — the hub conversations an agent's Identity was invited to, as a message source.

The agent's creator adds this source to the agent, as they would Slack or Telegram. A person invites the
agent to an ordinary hub conversation; the hub grants the Identity the answering deployment's machine
is signed in as, so the conversation is one that login can read. The
source is ONE stream over every such conversation: the hub's conversation list says which moved, a
conversation's messages are the records, a reply is ``add_message``. The deployment's serve loop
answers it like any other channel.

**Only as an agent.** A person's login reads the person's own conversations, which are never an
agent's to answer: signed out, or signed in as a person, the source reads nothing and sends nothing.

**Only plain conversations.** A help-desk ticket, an IT message and a monitoring channel are each
another kind of conversation with a source or a writer of its own; they are skipped.

**Every member may write.** The hub admitted each member of a conversation, so the source admits
any sender (``open_inbound``); the agent's own messages are told apart by its Identity (``whoami``).
"""

from __future__ import annotations

from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import Rejected
from flow_sdk.sources.hub_conversations import (
    AppHub,
    HubConversationSource,
    PoolEntry,
    change_token,
    newest_first,
    try_read_agent_login,
)

#: The channel these conversations are: half the thread key.
CHANNEL = "conversations"
#: The hub's kind for an ordinary 1:1 or group conversation, and what a row that names no kind is.
DIRECT = "direct"
#: The code ``ingest.health.classify`` gives the ``Rejected`` of ``require_ready``: the machine did not read as an
#: agent (signed out, or signed in as a person), so the source was parked until it does (``ensure_sources``).
REJECTED = "rejected"


class ConversationsSource(HubConversationSource):
    provider = "conversations"
    origin_kind = CHANNEL
    cursor_prefix = "conversations:"
    #: The hub admitted every member of a conversation: an empty allowlist admits each of them.
    open_inbound = True

    @classmethod
    def build(cls, binding: SourceBinding) -> "ConversationsSource":
        return cls(binding, hub=AppHub())

    @classmethod
    async def ensure_sources(cls) -> int:
        """Makes no source -- the agent's creator adds this one -- but, as the help desk's does, wakes the ones
        parked by a login that could not read: signed out or signed in as a person (``require_ready``), or refused
        by the hub (a 401). Runs on sign-in and start (``ensure_driver_sources``). Once this machine reads the
        conversation list as an agent again, that is no longer a configuration error; without this a source
        parked once never answers again, though a box signs in afresh on every resume. Returns 0."""
        from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
        from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
        from flow_sdk.ingest.health import ACCESS_DENIED, SourceHealth  # noqa: PLC0415

        if try_read_agent_login() is None:
            return 0
        walk = await HubProxy.walk("conversation")
        if not walk.complete:
            return 0
        for held in await DataSource.get_all({"provider": cls.provider}) or []:
            # This walk just succeeded as the agent, so a source parked because the login could not read is no
            # longer a configuration error.
            if held.health == SourceHealth.CONFIG_ERROR.value and held.error_code in (ACCESS_DENIED, REJECTED):
                await held.poll_now()
        return 0

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
