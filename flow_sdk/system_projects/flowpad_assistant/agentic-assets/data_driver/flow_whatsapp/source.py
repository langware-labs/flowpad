"""``FlowWhatsAppSource`` — Flow on WhatsApp: Flowpad's own number, your phone linked to it.

Nothing to set up at Meta. Flow is a hub agent answering on ONE number the hub holds; this source is one
person's conversation with it. Everything goes through the hub (``whatsapp_link/*``) — the number's token
never reaches this machine:

* **Connect** (``connect`` step): the hub mints a code and the ``wa.me`` link that pre-fills
  ``link <code>``; the person sends it from their phone. The hub VALIDATES it (the code is theirs,
  unexpired, unused; the phone is not someone else's) — only then is the link connected
  (``connected`` step: the gate the setup cannot pass without).
* **Answered on the hub**: Flow answers from a machine of the person's own that the hub places and
  replies through the number itself — nothing on this desktop answers.
* **Read**: this source is the person's view of that conversation in their stream inbox. The hub keeps
  no message: its ``@whatsapp`` webhook hands each one, and each answer Flow sent, to THIS channel on THIS
  instance as it happens (``/api/v1/data_source/<id>/webhook`` → ``events_from_webhook``). ``send``/
  ``reply`` reach only the person's own linked phone (``whatsapp_link/send``).

Addressing is the WhatsApp source's: the person IS the conversation (their wa_id), and a message lives in
their scope; a reply quotes the message it answers.
"""
from __future__ import annotations

import base64
from datetime import datetime, timezone
from typing import Any, Mapping, Optional, Protocol

from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import NotFound, OutcomeUnknown, Rejected, SourceUnavailable, Unsupported
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.setup_steps import ReturnedValue, SetupShown, SourceUpdateSpec, setup_step
from flow_sdk.sources.values.event import DataSourceEvent, EventKind
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.query import MessageQuery

#: The medium (the stream inbox shows it as WhatsApp), not the transport.
CHANNEL = "whatsapp"
MESSAGES_STREAM = "messages"


class HubTransport(Protocol):
    async def profile(self) -> dict: ...

    async def connect(self, channel: dict) -> dict: ...

    async def link(self, link_id: str) -> Optional[dict]: ...

    async def send(self, wa_id: str, text: str, reply_to: str) -> dict: ...


class AppHub:
    """The hub, as this desktop's signed-in user reaches it."""

    async def profile(self) -> dict:
        from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

        return dict(await hub_get("whatsapp_link", None, "flow_profile") or {})

    async def connect(self, channel: dict) -> dict:
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

        return dict(await hub_post("whatsapp_link", channel, None, "connect") or {})

    async def link(self, link_id: str) -> Optional[dict]:
        from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

        found = await hub_get("whatsapp_link", link_id)
        return dict(found) if isinstance(found, dict) else None

    async def send(self, wa_id: str, text: str, reply_to: str) -> dict:
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

        return dict(await hub_post("whatsapp_link", {"wa_id": wa_id, "text": text, "reply_to": reply_to}, None, "send") or {})


class FlowWhatsAppConfig(SourceConfig):
    """One person's link to Flow. Written by the setup steps, never typed."""

    #: The hub link this source reads through (pending until the phone sends its code).
    link_id: str = ""
    #: The person's phone, once the hub validated it.
    wa_id: str = ""


class FlowWhatsAppSource(MessageSource):

    Config = FlowWhatsAppConfig
    provider = "flow_whatsapp"
    origin_kind = CHANNEL
    identity_config_key = "wa_id"

    def __init__(self, binding: SourceBinding, hub: Optional[HubTransport] = None) -> None:
        super().__init__(binding)
        self._hub = hub

    @classmethod
    def build(cls, binding: SourceBinding) -> "FlowWhatsAppSource":
        return cls(binding, hub=AppHub())

    @classmethod
    async def profile(cls) -> dict:
        """Flow as the WhatsApp setup phase shows it — fetched from the hub, never hardcoded."""
        p = await AppHub().profile()
        if not p.get("available"):
            return {**p, "available": False, "detail": p.get("detail") or "Flow on WhatsApp is not available on your hub yet."}
        return p

    @property
    def hub(self) -> HubTransport:
        if self._hub is None:
            raise SourceUnavailable("no hub reaches this source")
        return self._hub

    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or (MESSAGES_STREAM,)))

    def conversation_origin(self, wa_id: str) -> CloudOrigin:
        return self.origin(wa_id)

    def message_origin(self, wamid: str, wa_id: str) -> CloudOrigin:
        return self.origin(wamid, MESSAGES_STREAM, wa_id)

    def _person_of_message(self, origin: CloudOrigin) -> str:
        """The wa_id a message origin hangs off — its conversation's person."""
        base = self.origin("-").namespace
        if not (origin.namespace == base or origin.namespace.startswith(base + "/")):
            raise ValueError(f"{origin!r} is outside this source's scope")
        wa_id = _digits(origin.namespace[len(base) + 1:]) if origin.namespace != base else ""
        if not wa_id:
            raise Rejected(f"{origin!r} names no person")
        return wa_id

    # ── setup steps (the flow-whatsapp-connect wizard calls these) ────────────
    @setup_step("connect")
    async def _connect(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue:
        """A live Connect code for this person: what to send from the phone, and Flow's card. ``check``
        holds while one is live (or the phone is already connected) — and SHOWS it, for the next question."""
        profile = await self.hub.profile()
        link_id = str(self.config.get("link_id") or "")
        current = await self.hub.link(link_id) if link_id else None
        live = current is not None and (current.get("status") == "connected" or _unexpired(current))
        if check:
            if not live:
                return ReturnedValue.not_yet("no Connect code yet")
            return ReturnedValue.satisfied("a Connect code is live", value=SourceUpdateSpec(shown=_shown(profile, current)), ran=False)
        if not profile.get("available"):
            return ReturnedValue.not_yet(str(profile.get("detail") or "Flow on WhatsApp is not available on your hub yet."))
        minted = await self.hub.connect(self._channel())
        if not minted.get("id"):
            return ReturnedValue.not_yet("The hub did not give a Connect code — try again.")
        return ReturnedValue.satisfied("a Connect code is ready", value=SourceUpdateSpec(
            config={"link_id": str(minted["id"])}, shown=_shown(profile, minted)))

    @setup_step("connected")
    async def _connected(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue:
        """The gate: the hub validated the code from the phone. Until then this says why not."""
        link_id = str(self.config.get("link_id") or "")
        link = await self.hub.link(link_id) if link_id else None
        if link is None:
            return ReturnedValue.not_yet("Press Connect WhatsApp first.")
        if link.get("status") != "connected":
            if not _unexpired(link):
                return ReturnedValue.not_yet("That code has expired — go back and press Connect WhatsApp again.")
            return ReturnedValue.not_yet("Not connected yet — send the message from your phone.")
        wa_id = str(link.get("wa_id") or "")
        if check:
            done = str(self.config.get("wa_id") or "") == wa_id
            return ReturnedValue.satisfied(f"connected +{wa_id}", ran=False) if done else ReturnedValue.not_yet("not kept yet")
        return ReturnedValue.satisfied(f"Connected +{wa_id}", value=SourceUpdateSpec(config={"wa_id": wa_id}, allowed_senders=[wa_id]))

    # ── read ────────────────────────────────────────────────────────────────
    def query(self) -> MessageQuery:
        return MessageQuery()

    def _channel(self) -> dict:
        """Where the hub hands this conversation: THIS instance, THIS channel."""
        try:
            from flow_sdk.instance_settings.runtime import instance_uid  # noqa: PLC0415

            instance = instance_uid()
        except Exception:  # noqa: BLE001 — no instance id: the hub still links the phone, the inbox stays empty
            instance = ""
        return {"instance_id": instance, "data_source_id": str(self.binding.source_id or "")}

    # ── inbound: what the hub hands this channel ─────────────────────────────
    def events_from_webhook(self, payload: Any) -> list[DataSourceEvent]:
        """One message of this person's conversation, in Meta's own envelope — written by them, or (marked
        ``flowpad_direction: out``) Flow's answer the hub sent. Total: anything else yields nothing. Only THIS
        source's phone: a person may hold an older source that never connected."""
        mine = str(self.config.get("wa_id") or "")
        outbound = isinstance(payload, dict) and payload.get("flowpad_direction") == "out"
        events: list[DataSourceEvent] = []
        for entry in _list(payload.get("entry") if isinstance(payload, dict) else None):
            for change in _list(entry.get("changes") if isinstance(entry, dict) else None):
                value = change.get("value") if isinstance(change, dict) and isinstance(change.get("value"), dict) else {}
                names = {
                    _digits(c.get("wa_id")): str((c.get("profile") or {}).get("name") or "")
                    for c in _list(value.get("contacts"))
                    if isinstance(c, dict)
                }
                for message in _list(value.get("messages")):
                    item = self._item(message, names, outbound=outbound) if isinstance(message, dict) else None
                    if item is not None and (not mine or item.data.conversation.key == mine):
                        events.append(DataSourceEvent(id=item.origin.key, kind=EventKind.UPSERT, origin=item.origin, item=item))
        return events

    def _item(self, message: dict, names: dict, *, outbound: bool) -> Optional[MessageItem]:
        wamid = str(message.get("id") or "").strip()
        wa_id = _digits(message.get("to") if outbound else message.get("from"))
        text = _text_of(message)
        if not (wamid and wa_id and text):
            return None
        sender = (
            UserProfile(origin=CloudOrigin(kind=CHANNEL, namespace="flow", key="flow"), name="Flow")
            if outbound
            else UserProfile(origin=self.conversation_origin(wa_id), name=names.get(wa_id) or None)
        )
        quoted = str((message.get("context") or {}).get("id") or "")
        data = MessageData(
            text=text,
            conversation=self.conversation_origin(wa_id),
            sender=sender,
            sent_at=_when(message.get("timestamp")),
            in_reply_to=self.message_origin(quoted, wa_id) if quoted else None,
        )
        return MessageItem(origin=self.message_origin(wamid, wa_id), data=data)

    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        """As the WhatsApp source addresses a send: the person IS the conversation (their wa_id), and
        ``in_reply_to`` quotes their message. Flow answers only the linked phone, so that phone is the
        default recipient. A subject has no equivalent."""
        wa_id = _digits(to) or _digits(thread_key) or _digits(str(self.config.get("wa_id") or ""))
        if not wa_id:
            raise ValueError("a Flow on WhatsApp send needs the linked phone's wa_id")
        quoted = str(in_reply_to or "").strip()
        if quoted:
            return MessageData(text=text), self.message_origin(quoted, wa_id)
        return MessageData(text=text, conversation=self.conversation_origin(wa_id)), None

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        if data.attachments:
            raise Unsupported("Flow on WhatsApp sends text")
        if (data.conversation is None) == (not data.recipients):
            raise ValueError("address exactly one of a conversation or recipients")
        wa_id = data.conversation.key if data.conversation is not None else _digits(data.recipients[0].origin.key)
        if not wa_id:
            raise NotFound("no WhatsApp number to send to")
        return await self._send(wa_id, data, quoted="")

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        wa_id = self._person_of_message(origin)
        sent = await self._send(wa_id, data, quoted=origin.key)
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"in_reply_to": origin}))

    async def _send(self, wa_id: str, data: MessageData, *, quoted: str) -> MessageItem:
        body = await self.hub.send(wa_id, data.text or "", quoted)
        wamid = str(body.get("wamid") or "")
        if not wamid:
            raise OutcomeUnknown("the hub accepted the message but returned no id for it")
        sent = MessageData(
            text=data.text, conversation=self.conversation_origin(wa_id),
            sender=UserProfile(origin=CloudOrigin(kind=CHANNEL, namespace="flow", key="flow"), name="Flow"),
            sent_at=datetime.now(timezone.utc),
        )
        return MessageItem(origin=self.message_origin(wamid, wa_id), data=sent)


def _shown(profile: dict, link: dict) -> SetupShown:
    code = str(link.get("code") or "")
    # ``connect`` answers with the link; a link read back later carries only its code.
    url = str(link.get("link") or "") or (f"{profile.get('wa_me')}?text=link%20{code}" if code and profile.get("wa_me") else "")
    return SetupShown(
        name=str(profile.get("name") or "Flow"), number=str(profile.get("number") or ""), avatar=str(profile.get("avatar") or ""),
        code=code, link=url, qr=_qr(url) if url else "", connected=link.get("status") == "connected",
    )


def _unexpired(link: dict) -> bool:
    return _float(link.get("code_expires_at")) > datetime.now(timezone.utc).timestamp()


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _text_of(message: dict) -> str:
    kind = message.get("type")
    if kind == "text":
        return str((message.get("text") or {}).get("body") or "")
    if kind == "button":
        return str((message.get("button") or {}).get("text") or "")
    if kind == "interactive":
        reply = message.get("interactive") or {}
        return str((reply.get("button_reply") or reply.get("list_reply") or {}).get("title") or "")
    return ""


def _when(timestamp: Any) -> datetime:
    """Meta sends unix seconds as a string."""
    try:
        return datetime.fromtimestamp(int(str(timestamp)), tz=timezone.utc)
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)


def _digits(value: Any) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _qr(url: str) -> str:
    """The link as a QR image (an SVG data URI) — scanned with the phone's camera to open WhatsApp."""
    import segno  # noqa: PLC0415

    import io  # noqa: PLC0415

    # A standalone SVG, namespace and all: an <img> renders nothing from the bare inline form. White baked in:
    # a camera reads dark-on-light, and segno's default (no background) left black squares on a dark dialog.
    out = io.BytesIO()
    segno.make(url, error="m").save(out, kind="svg", xmldecl=False, svgns=True, scale=4, border=2, dark="#000000", light="#ffffff")
    return "data:image/svg+xml;base64," + base64.b64encode(out.getvalue()).decode()
