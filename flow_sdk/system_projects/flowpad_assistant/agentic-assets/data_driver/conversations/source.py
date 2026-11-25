"""``ConversationsSource`` — the hub conversations an agent's Identity was invited to, as a message source.

The agent's creator adds this source to the agent, as they would Slack or Telegram. A person invites the
agent to an ordinary hub conversation. The answering deployment's machine is signed in as the deployment's
Identity, which holds no role on the conversation: it reaches the agent's conversations only through the
Agent's ``conversation_router`` action (``agent/<id>/conversation_router[/<conversation>/messages|add_message]``),
so what it posts is the AGENT's (``sender_id`` is the agent's id). The source is ONE stream over every such
conversation: the router's list says which moved, a conversation's messages are the records, a reply is
``add_message``. The deployment's serve loop answers it like any other channel.

**Only as an agent.** A person's login reads the person's own conversations, which are never an
agent's to answer: signed out, or signed in as a person, the source reads nothing and sends nothing.

**Only plain conversations.** A help-desk ticket, an IT message and a monitoring channel are each
another kind of conversation with a source or a writer of its own; they are skipped.

**Every member may write.** The hub admitted each member of a conversation, so the source admits
any sender (``open_inbound``); the agent's own messages are told apart by the agent's id (``whoami``).
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
    rows_of,
    try_resolve_login_agent,
)

#: The channel these conversations are: half the thread key.
CHANNEL = "conversations"
#: The hub's kind for an ordinary 1:1 or group conversation, and what a row that names no kind is.
DIRECT = "direct"
#: The Agent's hub action every one of its conversations is reached through: the list, and per conversation
#: ``<id>/messages`` and ``<id>/add_message``.
ROUTER = "conversation_router"
#: The code ``ingest.health.classify`` gives the ``Rejected`` of ``require_ready``: the machine did not read as an
#: agent (signed out, or signed in as a person), so the source was parked until it does (``ensure_sources``).
REJECTED = "rejected"


class ConversationsSource(HubConversationSource):
    provider = "conversations"
    origin_kind = CHANNEL
    cursor_prefix = "conversations:"
    #: The hub admitted every member of a conversation: an empty allowlist admits each of them.
    open_inbound = True
    #: The Agent this machine answers as, read when a session opens (``HubTransport.agent``); "" for none.
    _agent_id: str = ""

    @classmethod
    def build(cls, binding: SourceBinding) -> "ConversationsSource":
        return cls(binding, hub=AppHub())

    @classmethod
    async def ensure_sources(cls) -> int:
        """Makes no source -- the agent's creator adds this one -- but, as the help desk's does, wakes the ones
        parked by a login that could not read: signed out or signed in as a person (``require_ready``), or refused
        by the hub (a 401). Runs on sign-in and start (``ensure_driver_sources``). Once this machine reads the
        agent's conversation router again, that is no longer a configuration error; without this a source
        parked once never answers again, though a box signs in afresh on every resume. Returns 0."""
        from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
        from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
        from flow_sdk.ingest.health import ACCESS_DENIED, SourceHealth  # noqa: PLC0415

        agent = await try_resolve_login_agent()
        if agent is None:
            return 0
        if await HubProxy.try_call("GET", "agent", agent, ROUTER, strict=True) is None:
            return 0
        for held in await DataSource.get_all({"provider": cls.provider}) or []:
            # The router just answered the agent, so a source parked because the login could not read is no
            # longer a configuration error.
            if held.health == SourceHealth.CONFIG_ERROR.value and held.error_code in (ACCESS_DENIED, REJECTED):
                await held.poll_now()
        return 0

    async def _open(self) -> None:
        # Without a transport every call is ``SourceUnavailable``; opening is not one of them.
        self._agent_id = await self._hub.agent() if self._hub is not None else ""

    def signed_in_as(self) -> str:
        return self._agent_id

    def require_ready(self) -> None:
        if not self.signed_in_as():
            raise Rejected(
                "This source reads conversations only as an agent: sign this machine in to Flowpad Cloud "
                "as the agent's Identity."
            )

    async def prepare_answer(self, conversation: str) -> None:
        self.require_ready()

    async def _read_pool(self) -> list[PoolEntry]:
        """Every plain conversation the agent's router lists, newest activity first."""
        self.require_ready()
        pool = []
        for row in rows_of(await self.hub.get("agent", self._agent_id, ROUTER)):
            conversation = str(row.get("id") or "").strip()
            if not conversation or row.get("deleted_at") or str(row.get("kind") or DIRECT) != DIRECT:
                continue
            updated_at = str(row.get("updated_date") or "")
            pool.append(
                PoolEntry(
                    conversation, change_token(row.get("message_count"), updated_at, row.get("status")), updated_at
                )
            )
        return newest_first(pool)

    async def _read_messages(self, conversation: str) -> list[dict]:
        return rows_of(await self.hub.get("agent", self._agent_id, ROUTER, sub_path=f"{conversation}/messages"))

    async def _add_message(self, conversation: str, text: str) -> dict:
        body = await self.hub.post(
            "agent",
            {"text": text, "conversation_id": conversation},
            self._agent_id,
            ROUTER,
            sub_path=f"{conversation}/add_message",
        )
        return body if isinstance(body, dict) else {}


__all__ = ["CHANNEL", "ROUTER", "ConversationsSource"]
