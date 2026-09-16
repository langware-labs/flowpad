"""``AgentSource`` — a channel reached through a local agent harness, whose fetch is a model.

Every other source reaches its provider over a protocol. This one hands the work to a harness
worker that uses the connectors the user already authorised — how Gmail and Slack are read when
there is no first-class integration. Generic on purpose: ``config.connector`` names the channel,
and a second connector is a row of ``CONNECTOR_PROFILES``, not a new source.

**The worker records; this source does not.** The worker writes each message through the
application's ingest route itself, so a traversal returns no items — they already landed — and
only the receipt's high-water moves the cursor. The worker is a ``WorkerTransport`` the application
supplies: launching, budgets, deadlines and prompts are the application's.

A send's receipt may say the connector could only DRAFT (``sends_may_draft``): a draft is a real
outcome, and it comes back with no ``sent_at``.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Any, AsyncGenerator, ClassVar, Mapping, Optional, Protocol

from pydantic import StringConstraints

from flow_sdk.sources.base import Source, positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import AccessDenied, InvalidCursor, Rejected, SourceUnavailable, Unsupported
from flow_sdk.sources.values.items import EmailMessageData, MessageData, MessageItem
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import DataQuery, MessageQuery
from flow_sdk.sources.values.segment import SegmentRef

_RESUME = "resume:"


@dataclass(frozen=True)
class ConnectorProfile:
    """Everything about this transport that varies BY CONNECTOR, in one row: the kind its items
    carry, the personas that fetch and send (the fetch/send split exists because the send persona's
    prose forbids reading), what a segment is called, and whether one can be assumed."""

    kind: str
    segment_noun: str
    #: Assumed when config names no segments. Empty = segments are REQUIRED.
    default_segments: tuple[str, ...]
    agent: str
    subagent: str
    send_agent: str
    send_subagent: str


CONNECTOR_PROFILES: dict[str, ConnectorProfile] = {
    "gmail": ConnectorProfile(
        kind="content.message.email", segment_noun="mailbox", default_segments=("INBOX",),
        agent="email-summarizer", subagent="email_analyzer", send_agent="emailer", send_subagent="email_sender",
    ),
    "slack": ConnectorProfile(
        kind="content.message.chat", segment_noun="channel", default_segments=(),
        agent="slack-summarizer", subagent="slack_analyzer", send_agent="slack-poster", send_subagent="slack_sender",
    ),
}


def profile_of(config: Mapping[str, Any]) -> ConnectorProfile:
    """The connector's profile. ``connector`` is REQUIRED: the old fallback ("assume gmail") forked
    every thread in a source permanently, so refusing parks the source with the fix in the message."""
    connector = str((config or {}).get("connector") or "").strip().lower()
    if not connector:
        raise Rejected("config.connector is required (gmail | slack)")
    profile = CONNECTOR_PROFILES.get(connector)
    if profile is None:
        raise Rejected(f"connector {connector!r} has no profile; supported: {' | '.join(sorted(CONNECTOR_PROFILES))}")
    return profile


class WorkerTransport(Protocol):
    """A harness worker, as the application launches one."""

    async def fetch(self, *, source_id: str, name: str, config: Mapping[str, Any], segment_key: str, since: str) -> dict:
        """Run one fetch; the worker's receipt (``count``, ``high_water``, ``error``)."""
        ...

    async def send(
        self, *, source_id: str, config: Mapping[str, Any], channel: str, thread_key: str, to: str, text: str, subject: str, conversation_id: str
    ) -> dict:
        """Run one send; the confirmed outcome (``external_id``, ``drafted``, ``recorded``, ``artifact_id``)."""
        ...


class AgentSendData(EmailMessageData):
    """What a harness send is addressed by: the thread to reply into and the address to reach, plus
    the local conversation the reply belongs to (provenance for the run, never sent)."""

    spec_kind: ClassVar[str] = "ingest.message.agent.send"

    thread_key: str = ""
    to: str = ""
    conversation_id: str = ""


class AgentSentData(EmailMessageData):
    """A harness send's outcome: whether the worker also recorded the copy, and the deliverable it
    registered. ``sent_at`` is ``None`` for a draft."""

    spec_kind: ClassVar[str] = "ingest.message.agent.sent"

    recorded: bool = False
    artifact_id: str = ""


class AgentConfig(SourceConfig):
    """What a agent source is configured with."""

    connector: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    harness: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    segments: list[str] = []
    agent: str = ""
    subagent: str = ""
    max_items: Optional[int] = None
    send_agent: str = ""
    send_subagent: str = ""
    deadline_seconds: int = 300
    send_deadline_seconds: int = 120

    @classmethod
    def lift(cls, raw):
        """``streams`` / ``stream`` are what ``segments`` was called before the names converged."""
        raw = dict(raw)
        streams, stream = raw.pop("streams", None), raw.pop("stream", None)
        if not raw.get("segments") and (streams or stream):
            raw["segments"] = streams or [stream]
        return raw


class AgentSource(Source):

    Config = AgentConfig
    provider = "agent"
    #: The receipt's high-water is the only thing that says where the worker stopped.
    durable_cursor = True
    sends_may_draft: ClassVar[bool] = True

    def __init__(self, binding: SourceBinding, worker: Optional[WorkerTransport] = None) -> None:
        super().__init__(binding)
        self._worker = worker

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def build(cls, binding: SourceBinding) -> "AgentSource":
        from .transport import HarnessWorker  # noqa: PLC0415

        return cls(binding, worker=HarnessWorker())

    @classmethod
    def lift_cursor(cls, state: Mapping[str, Any]) -> Optional[str]:
        return cls.resume_after(state["high_water"]) if state.get("high_water") else None

    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        """The worker is handed the application's arguments as they are: it addresses the connector."""
        return AgentSendData(text=text, subject=subject or None, thread_key=thread_key, to=to, conversation_id=conversation_id), None

    @classmethod
    def origin_kind_for(cls, config: Mapping[str, Any]) -> str:
        """The connector IS the channel — otherwise every thread badges and keys as "agent"."""
        return str((config or {}).get("connector") or "").strip() or cls.provider

    @classmethod
    def namespace_for(cls, binding: SourceBinding) -> str:
        """A harness session is nobody's account: without one, the row is what scopes its threads."""
        return binding.account_key or binding.source_id or cls.provider

    @classmethod
    def resume_after(cls, high_water: str) -> str:
        return _RESUME + high_water

    @property
    def worker(self) -> WorkerTransport:
        if self._worker is None:
            raise SourceUnavailable("no harness worker reaches this source")
        return self._worker

    def segment_origin(self, key: str) -> CloudOrigin:
        return self.origin(key, key)

    async def segments(self) -> list[SegmentRef]:
        """What the source walks, one cursor each: ``segments``, else the connector's defaults. A row
        written with ``streams`` / ``stream`` arrives renamed (``AgentConfig.lift``)."""
        profile = profile_of(self.config)
        keys = self.config.get("segments") or list(profile.default_segments)
        refs = [SegmentRef(key=str(k), label=str(k), query=MessageQuery(conversation=self.segment_origin(str(k)))) for k in keys if str(k or "").strip()]
        if not refs:
            raise Rejected(f"config.segments is required: name at least one {profile.segment_noun}")
        return refs

    async def fetch(self, query: Optional[DataQuery] = None, *, cursor: Optional[str] = None, page_size: Optional[int] = None) -> ChangePage:
        self._require_open()
        if query is not None and not isinstance(query, DataQuery):
            raise TypeError(f"expected DataQuery, got {type(query).__name__}")
        if page_size is not None:
            positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        if query is not None and not isinstance(query, MessageQuery):
            raise Unsupported(f"AgentSource does not support {type(query).__name__}")
        if cursor is not None and (not isinstance(cursor, str) or not cursor.startswith(_RESUME) or len(cursor) == len(_RESUME)):
            raise InvalidCursor("not an agent-transport cursor")
        conversation = query.conversation if query is not None and query.conversation else None
        segment = conversation.key if conversation is not None else (await self.segments())[0].key
        since = cursor[len(_RESUME):] if cursor else (query.since.isoformat() if query is not None and query.since else "")
        receipt = await self.worker.fetch(
            source_id=self.binding.source_id, name=self.binding.name, config=self.config, segment_key=segment, since=since
        )
        reported = receipt.get("error")
        if reported:
            if str(reported) == "no_connector":
                raise AccessDenied("the harness has no connector for this channel in this session")
            raise SourceUnavailable(f"the ingest agent reported: {reported}")
        high_water = str(receipt.get("high_water") or "")
        # No items: the worker recorded them through the ingest route; returning them would ingest twice.
        return ChangePage(items=(), resume_cursor=_RESUME + high_water if high_water else cursor)

    async def iterate(self, query: Optional[DataQuery] = None, *, page_size: Optional[int] = None) -> AsyncGenerator[MessageItem, None]:
        await self.fetch(query, page_size=page_size)
        return
        yield  # pragma: no cover — an async generator that yields nothing: the worker records

    async def send(self, data: MessageData) -> MessageItem:
        """One harness send. A refused or unconfirmed send is the APPLICATION's launch error and
        propagates as such: one failed reply must never become source health."""
        self._require_open()
        if not isinstance(data, MessageData):
            raise TypeError(f"expected MessageData, got {type(data).__name__}")
        if not (data.text or "").strip():
            raise ValueError("a harness send needs text")
        thread_key = getattr(data, "thread_key", "") or (data.conversation.key if data.conversation is not None else "")
        to = getattr(data, "to", "") or (data.recipients[0].address or data.recipients[0].origin.key if data.recipients else "")
        outcome = await self.worker.send(
            source_id=self.binding.source_id, config=self.config, channel=self.origin_kind_for(self.config),
            thread_key=thread_key, to=to, text=data.text or "", subject=getattr(data, "subject", None) or "",
            conversation_id=getattr(data, "conversation_id", ""),
        )
        drafted = bool(outcome.get("drafted"))
        external_id = str(outcome.get("external_id") or "")
        sent = AgentSentData(
            text=data.text, subject=getattr(data, "subject", None), conversation=data.conversation,
            sent_at=None if drafted else datetime.now(timezone.utc),
            recorded=bool(outcome.get("recorded")), artifact_id=str(outcome.get("artifact_id") or ""),
        )
        return MessageItem(origin=self.origin(external_id or "unconfirmed", thread_key or "sent"), data=sent)

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        raise Unsupported("the agent transport replies into a thread; send to the conversation instead")


__all__ = ["CONNECTOR_PROFILES", "AgentSendData", "AgentSentData", "AgentSource", "ConnectorProfile", "WorkerTransport", "profile_of"]
