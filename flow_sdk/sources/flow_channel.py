"""``FlowChannel`` — one person's conversation with Flow on one of the platform's channels.

Flow is a hub agent answering on the PLATFORM's own channel accounts (a WhatsApp number, a Telegram bot, a Slack
app), which the hub holds. Nothing to set up at the vendor: a person links their own account on that channel to
their Flowpad account, and from then on they talk to Flow there. Every channel driver ships on this base and owns
only what is the vendor's — the envelope its messages arrive in (``items_of``) and how a person's id reads
(``sender_of`` / ``display_sender``). Everything else is the same on all of them, which is the point:

* **Connect** (``connect`` step): the hub mints a code and the deep link that sends it (``channel_link/connect``);
  the person sends it from their account. The hub VALIDATES it (the code is theirs, unexpired, unused; the account
  is not someone else's) — only then is the link connected (``connected`` step: the gate setup cannot pass).
* **Answered on the hub**: Flow answers from a machine the hub places for the person and replies through the
  platform's account itself — nothing on this desktop answers.
* **Read**: this source is the person's view of that conversation in their stream inbox. The hub keeps no
  message: its ``@<channel>`` webhook hands each one, and each answer Flow sent (``flowpad_direction: out``), to
  THIS channel on THIS instance as it happens (``/api/v1/data_source/<id>/webhook`` → ``events_from_webhook``).
  ``send`` / ``reply`` reach only the person's own linked account (``channel_link/send``).

Addressing: the person IS the conversation (their id on the channel), and a message lives in their scope; a reply
quotes the message it answers. The platform's credentials never reach this machine.
"""

from __future__ import annotations

import base64
import io
from datetime import datetime, timezone
from typing import Any, ClassVar, Mapping, Optional, Protocol

from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import NotFound, OutcomeUnknown, Rejected, SourceUnavailable, Unsupported
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.setup_steps import ReturnedValue, SetupShown, SourceUpdateSpec, setup_step
from flow_sdk.sources.values.event import DataSourceEvent, EventKind
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.query import MessageQuery

MESSAGES_STREAM = "messages"
#: The hub entity every channel's link lives on.
LINK_ENTITY = "channel_link"


class FlowHub(Protocol):
    """What a Flow channel asks of the hub."""

    async def profile(self, channel: str) -> dict: ...

    async def connect(self, channel: str, where: dict) -> dict: ...

    async def link(self, link_id: str) -> Optional[dict]: ...

    async def send(self, channel: str, sender: str, text: str, reply_to: str) -> dict: ...


class AppHub:
    """The hub, as this desktop's signed-in user reaches it."""

    async def profile(self, channel: str) -> dict:
        from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

        return dict(await hub_get(LINK_ENTITY, None, "profile", params={"provider": channel}) or {})

    async def connect(self, channel: str, where: dict) -> dict:
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

        return dict(await hub_post(LINK_ENTITY, {**where, "provider": channel}, None, "connect") or {})

    async def link(self, link_id: str) -> Optional[dict]:
        from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

        found = await hub_get(LINK_ENTITY, link_id)
        return dict(found) if isinstance(found, dict) else None

    async def send(self, channel: str, sender: str, text: str, reply_to: str) -> dict:
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

        body = {"provider": channel, "sender": sender, "text": text, "reply_to": reply_to}
        return dict(await hub_post(LINK_ENTITY, body, None, "send") or {})


class FlowChannelConfig(SourceConfig):
    """One person's link to Flow. Written by the setup steps, never typed."""

    #: The hub link this source reads through (pending until the person sends its code).
    link_id: str = ""
    #: The person's own id on the channel, once the hub validated it.
    sender: str = ""


class FlowChannel(MessageSource):
    """The base every Flow channel driver subclasses: set ``channel`` (the hub's provider name), ``title`` and
    ``origin_kind``; implement ``items_of``."""

    Config = FlowChannelConfig
    identity_config_key = "sender"
    #: The hub's name for the channel (``webhook_providers`` adapter): what ``channel_link`` is asked about.
    channel: ClassVar[str] = ""
    #: The channel as people name it ("WhatsApp"), in what the setup says.
    title: ClassVar[str] = ""
    #: What the person sends the code from ("phone"); the channel's name when unset.
    noun: ClassVar[str] = ""

    def __init__(self, binding: SourceBinding, hub: Optional[FlowHub] = None) -> None:
        super().__init__(binding)
        self._hub = hub

    @classmethod
    def build(cls, binding: SourceBinding) -> "FlowChannel":
        return cls(binding, hub=AppHub())

    @classmethod
    async def profile(cls) -> dict:
        """Flow as this channel's setup shows it — fetched from the hub, never hardcoded."""
        p = await AppHub().profile(cls.channel)
        if not p.get("available"):
            return {**p, "available": False, "detail": p.get("detail") or cls._unavailable()}
        return {**p, "number": str(p.get("display") or p.get("number") or "")}

    @classmethod
    def _unavailable(cls) -> str:
        return f"Flow on {cls.title} is not available on your hub yet."

    @property
    def hub(self) -> FlowHub:
        if self._hub is None:
            raise SourceUnavailable("no hub reaches this source")
        return self._hub

    @property
    def connect_label(self) -> str:
        return f"Connect {self.title}"

    @property
    def linked_sender(self) -> str:
        return str(self.config.get(self.identity_config_key) or "")

    # ── what a channel driver owns ───────────────────────────────────────────
    def items_of(self, payload: dict, *, outbound: bool) -> list[dict]:
        """The messages in one vendor envelope the hub handed this channel, each as ``{id, sender, name, text,
        reply_to, at}`` — ``sender`` being the person (the recipient, for Flow's own ``outbound`` answer)."""
        raise NotImplementedError

    def sender_of(self, value: Any) -> str:
        """A person's id on this channel, normalised (a WhatsApp number keeps its digits only)."""
        return str(value or "").strip()

    def display_sender(self, sender: str) -> str:
        """How the setup names the linked account ("+972…" for a phone)."""
        return sender

    # ── addressing ───────────────────────────────────────────────────────────
    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or (MESSAGES_STREAM,)))

    def conversation_origin(self, sender: str) -> CloudOrigin:
        return self.origin(sender)

    def message_origin(self, message_id: str, sender: str) -> CloudOrigin:
        return self.origin(message_id, MESSAGES_STREAM, sender)

    def flow_profile(self) -> UserProfile:
        return UserProfile(origin=CloudOrigin(kind=self.origin_kind, namespace="flow", key="flow"), name="Flow")

    def _person_of_message(self, origin: CloudOrigin) -> str:
        """The person a message origin hangs off — its conversation's sender."""
        base = self.origin("-").namespace
        if not (origin.namespace == base or origin.namespace.startswith(base + "/")):
            raise ValueError(f"{origin!r} is outside this source's scope")
        sender = self.sender_of(origin.namespace[len(base) + 1 :]) if origin.namespace != base else ""
        if not sender:
            raise Rejected(f"{origin!r} names no person")
        return sender

    # ── setup steps (each driver's connect wizard calls these) ───────────────
    @setup_step("connect")
    async def _connect(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue:
        """A live Connect code for this person: what to send from their account, and Flow's card. ``check`` holds
        while one is live (or the account is already connected) — and SHOWS it, for the next question."""
        profile = await self.hub.profile(self.channel)
        link_id = str(self.config.get("link_id") or "")
        current = await self.hub.link(link_id) if link_id else None
        live = current is not None and (current.get("status") == "connected" or _unexpired(current))
        if check:
            if not live:
                return ReturnedValue.not_yet("no Connect code yet")
            shown = SourceUpdateSpec(shown=self._shown(profile, current))
            return ReturnedValue.satisfied("a Connect code is live", value=shown, ran=False)
        if not profile.get("available"):
            return ReturnedValue.not_yet(str(profile.get("detail") or self._unavailable()))
        minted = await self.hub.connect(self.channel, self._channel())
        if not minted.get("id"):
            return ReturnedValue.not_yet("The hub did not give a Connect code — try again.")
        return ReturnedValue.satisfied(
            "a Connect code is ready",
            value=SourceUpdateSpec(config={"link_id": str(minted["id"])}, shown=self._shown(profile, minted)),
        )

    @setup_step("connected")
    async def _connected(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue:
        """The gate: the hub validated the code from the person's account. Until then this says why not."""
        link_id = str(self.config.get("link_id") or "")
        link = await self.hub.link(link_id) if link_id else None
        if link is None:
            return ReturnedValue.not_yet(f"Press {self.connect_label} first.")
        if link.get("status") != "connected":
            if not _unexpired(link):
                return ReturnedValue.not_yet(f"That code has expired — go back and press {self.connect_label} again.")
            return ReturnedValue.not_yet(f"Not connected yet — send the message from your {self.noun or self.title}.")
        sender = self.sender_of(link.get("sender"))
        shown = self.display_sender(sender)
        if check:
            done = self.linked_sender == sender
            return ReturnedValue.satisfied(f"connected {shown}", ran=False) if done else ReturnedValue.not_yet("not kept yet")
        return ReturnedValue.satisfied(
            f"Connected {shown}",
            value=SourceUpdateSpec(config={self.identity_config_key: sender}, allowed_senders=[sender]),
        )

    def _shown(self, profile: dict, link: dict) -> SetupShown:
        code = str(link.get("code") or "")
        # ``connect`` answers with the deep link; a link read back later carries only its code.
        url = str(link.get("deep_link") or "")
        return SetupShown(
            name=str(profile.get("name") or "Flow"),
            number=str(profile.get("display") or ""),
            avatar=str(profile.get("avatar") or ""),
            code=code,
            link=url,
            qr=_qr(url) if url else "",
            connected=link.get("status") == "connected",
        )

    # ── read ────────────────────────────────────────────────────────────────
    def query(self) -> MessageQuery:
        return MessageQuery()

    def _channel(self) -> dict:
        """Where the hub hands this conversation: THIS instance, THIS channel."""
        try:
            from flow_sdk.instance_settings.runtime import instance_uid  # noqa: PLC0415

            instance = instance_uid()
        except Exception:  # noqa: BLE001 — no instance id: the hub still links the account, the stream inbox stays empty
            instance = ""
        return {"instance_id": instance, "data_source_id": str(self.binding.source_id or "")}

    # ── inbound: what the hub hands this channel ─────────────────────────────
    def events_from_webhook(self, payload: Any) -> list[DataSourceEvent]:
        """One message of this person's conversation, in the vendor's own envelope — written by them, or (marked
        ``flowpad_direction: out``) Flow's answer the hub sent. Total: anything else yields nothing. Only THIS
        source's account: a person may hold an older source that never connected."""
        if not isinstance(payload, dict):
            return []
        mine = self.linked_sender
        outbound = payload.get("flowpad_direction") == "out"
        events: list[DataSourceEvent] = []
        for message in self.items_of(payload, outbound=outbound):
            item = self._item(message, outbound=outbound)
            if item is not None and (not mine or item.data.conversation.key == mine):
                events.append(DataSourceEvent(id=item.origin.key, kind=EventKind.UPSERT, origin=item.origin, item=item))
        return events

    def _item(self, message: dict, *, outbound: bool) -> Optional[MessageItem]:
        message_id = str(message.get("id") or "").strip()
        sender = self.sender_of(message.get("sender"))
        text = str(message.get("text") or "")
        if not (message_id and sender and text):
            return None
        author = (
            self.flow_profile()
            if outbound
            else UserProfile(origin=self.conversation_origin(sender), name=message.get("name") or None)
        )
        quoted = str(message.get("reply_to") or "")
        data = MessageData(
            text=text,
            conversation=self.conversation_origin(sender),
            sender=author,
            sent_at=message.get("at") or datetime.now(timezone.utc),
            in_reply_to=self.message_origin(quoted, sender) if quoted else None,
        )
        return MessageItem(origin=self.message_origin(message_id, sender), data=data)

    def message_for(
        self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""
    ):
        """The person IS the conversation, and ``in_reply_to`` quotes their message. Flow answers only the linked
        account, so that account is the default recipient. A subject has no equivalent."""
        sender = self.sender_of(to) or self.sender_of(thread_key) or self.linked_sender
        if not sender:
            raise ValueError(f"a Flow on {self.title} send needs the linked account")
        quoted = str(in_reply_to or "").strip()
        if quoted:
            return MessageData(text=text), self.message_origin(quoted, sender)
        return MessageData(text=text, conversation=self.conversation_origin(sender)), None

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        if data.attachments:
            raise Unsupported(f"Flow on {self.title} sends text")
        if (data.conversation is None) == (not data.recipients):
            raise ValueError("address exactly one of a conversation or recipients")
        sender = data.conversation.key if data.conversation is not None else self.sender_of(data.recipients[0].origin.key)
        if not sender:
            raise NotFound(f"no {self.title} account to send to")
        return await self._send(sender, data, quoted="")

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        sender = self._person_of_message(origin)
        sent = await self._send(sender, data, quoted=origin.key)
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"in_reply_to": origin}))

    async def _send(self, sender: str, data: MessageData, *, quoted: str) -> MessageItem:
        body = await self.hub.send(self.channel, sender, data.text or "", quoted)
        message_id = str(body.get("message_id") or "")
        if not message_id:
            raise OutcomeUnknown("the hub accepted the message but returned no id for it")
        sent = MessageData(
            text=data.text,
            conversation=self.conversation_origin(sender),
            sender=self.flow_profile(),
            sent_at=datetime.now(timezone.utc),
        )
        return MessageItem(origin=self.message_origin(message_id, sender), data=sent)


def unix_time(value: Any) -> Optional[datetime]:
    """A vendor's unix seconds (a number or its string), or None."""
    try:
        return datetime.fromtimestamp(float(str(value)), tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def _unexpired(link: dict) -> bool:
    try:
        return float(link.get("code_expires_at") or 0) > datetime.now(timezone.utc).timestamp()
    except (TypeError, ValueError):
        return False


def _qr(url: str) -> str:
    """The deep link as a QR image (an SVG data URI) — scanned with the phone's camera to open the channel."""
    import segno  # noqa: PLC0415

    # A standalone SVG, namespace and all: an <img> renders nothing from the bare inline form. White baked in:
    # a camera reads dark-on-light, and segno's default (no background) left black squares on a dark dialog.
    out = io.BytesIO()
    segno.make(url, error="m").save(
        out, kind="svg", xmldecl=False, svgns=True, scale=4, border=2, dark="#000000", light="#ffffff"
    )
    return "data:image/svg+xml;base64," + base64.b64encode(out.getvalue()).decode()


__all__ = ["AppHub", "FlowChannel", "FlowChannelConfig", "FlowHub", "LINK_ENTITY", "MESSAGES_STREAM", "unix_time"]
