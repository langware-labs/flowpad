"""``FlowConversationSource`` -- a help desk's team conversations as a channel an agent serves.

A ticket's team conversation is where the desk's staff, and the internal agent, work a ticket: people write there, and
the support agent (untrusted, it talks to the customer) writes there only as *guest messages* that the hub screens
first. The hub fans every message of that conversation out to its members, so each arrives on this machine as a
``FlowMessage`` row; the source LISTS the ones an agent is called by and the sync engine pulls them like any channel.
The bus only says "pull now" (``bus_topics`` + ``wants``): a lost event is latency, never loss.

What calls the agent -- exactly two things, and nothing else is listed at all:

* a **guest message whose screening passed** (or a person released). The hub fills its text in only then, so the text
  of a message still pending, held or rejected is never on this machine and never reaches a turn. Its key is
  ``<message id>:passed``, so the update that flips it from pending is the arrival, whatever came before;
* a **person's message that tags the agent** (``mentions`` carries its hub user id). Key ``<message id>:tagged``.

Never: the agent's own words, a steer (the internal agent's own message into the support agent's process), or the
hub's lines (a ticket closed). The agent answers in free text, into the same conversation (``send`` is
``add_message``); its reply mode here is ``always`` -- people are in the conversation, so ``auto`` would silence it.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, ClassVar, Optional, Sequence

from pydantic import StringConstraints

from flow_sdk.builtin.source_item import MessageSpec
from flow_sdk.sources.base import CollectionSource
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import NotFound, OutcomeUnknown, Rejected, Unsupported
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.memory import check_outgoing
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.query import DataQuery, MessageQuery
from flow_sdk.utils.serialization import iso_to_utc

CHANNEL = "flow_conversation"
#: The tag an arriving Flowpad conversation message is announced under, once its row is stored here.
ARRIVED_TAG = "stream_inbox.flowpad.message.projected"
PASSED = "passed"
TAGGED = "tagged"


class FlowConversationMessageData(MessageData):
    """One message of a team conversation that calls the agent."""

    spec_kind: ClassVar[str] = "ingest.message.flow_conversation"

    hub_conversation_id: Optional[str] = None
    hub_message_id: Optional[str] = None
    #: Not a call to act: never set on what this source lists (it lists only what calls the agent).
    quiet: bool = False


class FlowConversationMessageSpec(MessageSpec):
    """Said into a team conversation: free text, as a message of that conversation."""

    @classmethod
    def reply_to(cls, m, *, body: str, files=()) -> "FlowConversationMessageSpec":
        thread_key = str(getattr(m, "thread_key", "") or "")
        return cls(to=[thread_key], body=body, thread_key=thread_key, files=list(files))


class FlowConversationConfig(SourceConfig):
    desk_project_id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class FlowConversationSource(MessageSource, CollectionSource):
    Config = FlowConversationConfig
    provider = "flow_conversation"
    origin_kind = CHANNEL
    identity_config_key = "desk_project_id"
    supported_queries = (MessageQuery,)
    item_type = MessageItem
    #: Whoever is in a team conversation may call the agent: the hub already decided who that is.
    open_inbound = True
    #: A message the agent writes comes back through the hub mirror under its own id, never as a new call.
    echoes_sends = False
    #: A Flowpad conversation message arriving here (or a guest message flipping to passed) says "pull now".
    bus_topics: ClassVar[tuple[str, ...]] = (ARRIVED_TAG,)
    #: People are in the conversation, so ``auto`` would silence the agent: it answers in free text, always.
    default_reply_mode: ClassVar[Optional[str]] = "always"

    @classmethod
    def wants(cls, tag: str, data: dict) -> bool:
        return tag == ARRIVED_TAG

    @classmethod
    def outbound_spec(cls) -> type:
        return FlowConversationMessageSpec

    @property
    def desk(self) -> str:
        return str(self.config.get("desk_project_id") or "").strip()

    def thread(self, conversation_id: str) -> CloudOrigin:
        return self.origin(conversation_id, conversation_id)

    def query(self) -> Optional[DataQuery]:
        return MessageQuery()

    # ── the listing ─────────────────────────────────────────────────────────
    async def _scan(self, query: Optional[DataQuery]) -> Sequence[tuple[str, Any]]:
        from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

        me = _me()
        since = getattr(query, "since", None)
        entries: list[tuple[str, Any]] = []
        for conversation in await self._team_conversations():
            for fm in await FlowMessage.get_all({"conversation_id": str(conversation.id)}) or []:
                call = self._call_of(fm, me)
                if call is None or not _in_window(fm, since):
                    continue
                entries.append((f"{fm.id}:{call}", fm))
        return sorted(entries, key=lambda entry: entry[0])

    async def _lookup(self, key: str) -> Any:
        from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

        message_id, _, call = key.partition(":")
        fm = await FlowMessage.get_one({"id": message_id}) if message_id else None
        if fm is None or self._call_of(fm, _me()) != call:
            return None
        conversation = await self._conversation(str(fm.conversation_id or ""))
        return fm if conversation is not None else None

    def _item(self, key: str, raw: Any) -> MessageItem:
        conversation_id = str(raw.conversation_id or "")
        sender = str(raw.sender_id or "")
        data = FlowConversationMessageData(
            text=str(raw.text or ""),
            conversation=self.thread(conversation_id),
            sender=UserProfile(
                origin=CloudOrigin(kind=CHANNEL, namespace="hub-users", key=sender), name=str(raw.sender_name or sender)
            )
            if sender
            else None,
            sent_at=iso_to_utc(raw.created_date),
            hub_conversation_id=conversation_id,
            hub_message_id=str(raw.id),
        )
        return MessageItem(origin=self.origin(key, conversation_id), data=data)

    def _key_of(self, origin: object) -> str:
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        conversation = self._conversation_of(origin)
        if not conversation or origin.key == conversation:
            raise ValueError(f"{origin!r} is outside this source's scope")
        return origin.key

    def _call_of(self, fm: Any, me: str) -> Optional[str]:
        """What makes ``fm`` call the agent -- ``"passed"`` or ``"tagged"`` -- or ``None`` for everything else."""
        from flow_sdk.builtin.flow_message import FlowMessageKind  # noqa: PLC0415

        if me and str(fm.sender_id or "") == me:
            return None  # the agent's own words
        kind = str(getattr(fm.kind, "value", fm.kind) or "")
        if kind == FlowMessageKind.GUEST_MESSAGE.value:
            ref = fm.guest_message or {}
            return PASSED if ref.get("status") == PASSED and str(fm.text or "").strip() else None
        if kind in (FlowMessageKind.STEER.value, FlowMessageKind.TICKET_EVENT.value):
            return None
        return TAGGED if me and me in (fm.mentions or []) and str(fm.text or "").strip() else None

    async def _team_conversations(self) -> list:
        from flow_sdk.builtin.conversation import Conversation, ConversationKind  # noqa: PLC0415
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

        rows = await Conversation.get_all(
            QueryFilter(match=ExpressionNode(op=QueryOp.EQ, operands=["kind", ConversationKind.HELPDESK_TEAM.value]))
        )
        return [c for c in rows or [] if self._is_ours(c)]

    async def _conversation(self, conversation_id: str) -> Any:
        from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415

        conversation = await Conversation.get_one({"id": conversation_id}) if conversation_id else None
        return conversation if conversation is not None and self._is_ours(conversation) else None

    def _is_ours(self, conversation: Any) -> bool:
        """A ticket's team conversation of this desk: the hub stamps both the kind and the desk, and a row that does not
        say which desk it belongs to is not taken."""
        from flow_sdk.builtin.conversation import ConversationKind  # noqa: PLC0415

        if str(getattr(conversation, "kind", "") or "") != ConversationKind.HELPDESK_TEAM.value:
            return False
        return str(getattr(conversation, "remote_project_id", "") or "") == self.desk

    def _conversation_of(self, origin: CloudOrigin) -> str:
        account = self.binding.account_key
        prefix = f"{account}/" if account else ""
        if origin.kind != self._scope.kind or not origin.namespace.startswith(prefix):
            return ""
        return origin.namespace[len(prefix) :]

    # ── sending: free text into the team conversation ───────────────────────
    def message_for(
        self,
        *,
        thread_key: str,
        to: str,
        text: str,
        subject: str = "",
        in_reply_to: str = "",
        conversation_id: str = "",
    ):
        conversation = str(conversation_id or to or thread_key or "").strip()
        if not conversation:
            raise ValueError("a team conversation message needs the conversation it goes into")
        return MessageData(text=text, conversation=self.thread(conversation)), None

    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        check_outgoing(data, reply=False)
        if data.conversation is None:
            raise Unsupported("a team conversation message goes into the conversation, not to recipients")
        conversation = self._conversation_of(data.conversation)
        if not conversation or data.conversation.key != conversation:
            raise NotFound("not a team conversation of this desk", origin=data.conversation)
        return await self._post(conversation, data.text or "", None)

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        check_outgoing(data, reply=True)
        self._key_of(origin)
        conversation = self._conversation_of(origin)
        return await self._post(conversation, data.text or "", origin)

    async def _post(self, conversation_id: str, text: str, answered: Optional[CloudOrigin]) -> MessageItem:
        from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415

        if await self._conversation(conversation_id) is None:
            raise NotFound("not a team conversation of this desk", origin=self.thread(conversation_id))
        try:
            body = await HubProxy.call(
                "POST",
                "conversation",
                conversation_id,
                "add_message",
                payload={"text": text, "conversation_id": conversation_id},
                strict=True,
            )
        except HubError as exc:
            raise Rejected(f"the hub refused the message ({getattr(exc, 'status_code', 0)}): {exc}") from exc
        message_id = str((body or {}).get("id") or "")
        if not message_id:
            raise OutcomeUnknown("the hub accepted the message but returned no id for it")
        data = FlowConversationMessageData(
            text=text,
            conversation=self.thread(conversation_id),
            sender=UserProfile(origin=CloudOrigin(kind=CHANNEL, namespace="hub-users", key=_me())),
            sent_at=datetime.now(timezone.utc),
            in_reply_to=answered,
            hub_conversation_id=conversation_id,
            hub_message_id=message_id,
            quiet=True,
        )
        return MessageItem(origin=self.origin(f"{message_id}:sent", conversation_id), data=data)


def _me() -> str:
    """The hub user (or the agent's Identity, on its machine) this instance is signed in as, or ``""``."""
    try:
        from flow_sdk.cli.app_config import get_principal  # noqa: PLC0415

        return str((get_principal() or {}).get("id") or "")
    except Exception:  # noqa: BLE001
        return ""


def _in_window(fm: Any, since: Optional[datetime]) -> bool:
    sent_at = iso_to_utc(fm.created_date)
    return since is None or sent_at is None or sent_at >= since
