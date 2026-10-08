"""``FlowChannel`` — one person's conversation on one of the platform's channel accounts.

The hub holds the PLATFORM's own channel accounts (a WhatsApp number, a Telegram bot, a Slack app). Nothing to set
up at the vendor: a person links their own account on that channel to their Flowpad account, and from then on what
they write there arrives HERE. The hub only chains the vendor's webhook to this channel (``docs/flow-channels.md``
on the hub). Every channel driver ships on this base and owns only what is the vendor's — the envelope its messages
arrive in (``items_of``) and how a person's id reads (``sender_of`` / ``display_sender``):

* **Connect** (``connect`` step): a pending user claim on the hub's ``webhook/@<channel>`` root, targeted at THIS
  channel on THIS instance (``webhook/chain``); it answers a code and the deep link that sends it. The person sends
  it from their account; the hub VALIDATES it (the code is theirs, unexpired, unused; the account is not someone
  else's) and the claim goes active (``connected`` step: the gate setup cannot pass).
* **Inbound**: the hub hands each message to ``/api/v1/data_source/<id>/webhook`` → ``events_from_webhook``. It
  keeps no message.
* **Send / reply** go back through the claim (``webhook/<claim>/reply``): the platform's credentials never reach
  this machine. A reply names the message it answers; a plain send goes to the claim's own linked account.
* **Who answers** is this instance's business (an agent serving the source); the hub answers nothing.

Addressing: the person IS the conversation (their id on the channel), and a message lives in their scope.
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
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.setup_steps import ReturnedValue, SetupShown, SourceUpdateSpec, setup_step
from flow_sdk.sources.values.event import DataSourceEvent, EventKind
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.query import MessageQuery

MESSAGES_STREAM = "messages"
#: The platform's own account on every such channel, as the setup card and a sent message name it.
PLATFORM_NAME = "Flowpad"
#: The hub entity a channel's claim is.
CLAIM_ENTITY = "webhook"


class FlowHub(Protocol):
    """What a Flow channel asks of the hub: a claim on the channel's root, and the way back through it."""

    async def connect(self, channel: str, target: dict) -> dict: ...

    async def claim(self, claim_id: str) -> Optional[dict]: ...

    async def reply(self, claim_id: str, text: str, event_id: str) -> dict: ...


class AppHub:
    """The hub, as this desktop's signed-in user reaches it."""

    async def connect(self, channel: str, target: dict) -> dict:
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

        body = {"parent": f"@{channel}", "claim": {"kind": "user"}, "target": {"kind": "desktop", **target}}
        return dict(await hub_post(CLAIM_ENTITY, body, None, "chain") or {})

    async def claim(self, claim_id: str) -> Optional[dict]:
        """The claim as the hub has it; ``None`` when the hub says it is gone (404) or not ours (403). Any other answer
        goes through the one status table; no answer at all is ``SourceUnavailable`` — not knowing is not "not
        connected"."""
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
        from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415
        from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind  # noqa: PLC0415
        from flow_sdk.sources.http import error_for_status  # noqa: PLC0415

        try:
            found = await hub_get_or_raise(CLAIM_ENTITY, claim_id, "view")
        except HubError as exc:
            if exc.status_code in (403, 404):
                return None
            if exc.status_code:
                raise error_for_status(exc.status_code, exc.reason) from exc
            if exc.kind is HubFailureKind.NOT_CONFIGURED:
                raise Rejected("no hub is configured for this machine") from exc
            raise SourceUnavailable(f"the hub did not answer: {exc.reason}") from exc
        return dict(found) if isinstance(found, dict) else None

    async def reply(self, claim_id: str, text: str, event_id: str) -> dict:
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

        return dict(await hub_post(CLAIM_ENTITY, {"text": text, "event_id": event_id}, claim_id, "reply") or {})


class FlowChannelConfig(SourceConfig):
    """One person's link to the channel. Written by the setup steps, never typed."""

    #: The hub claim this source receives through (pending until the person sends its code).
    claim_id: str = ""
    #: The person's own id on the channel, once the hub validated it.
    sender: str = ""


class FlowChannel(MessageSource):
    """The base every Flow channel driver subclasses: set ``channel`` (the hub's provider name), ``title`` and
    ``origin_kind``; implement ``items_of``."""

    Config = FlowChannelConfig
    identity_config_key = "sender"
    #: The hub's name for the channel (its ``webhook_providers`` adapter): the root claimed is ``@<channel>``.
    channel: ClassVar[str] = ""
    #: The channel as people name it ("WhatsApp"), in what the setup says.
    title: ClassVar[str] = ""
    #: What the person sends the code from ("phone"); the channel's name when unset.
    noun: ClassVar[str] = ""
    #: Its messages arrive only through the hub's claim (``events_from_webhook``); it fetches nothing itself.
    delivered_by_hub: ClassVar[bool] = True
    #: The claim already admits only its proven sender (and ``events_from_webhook`` keeps only the linked one), so
    #: an agent answers whatever arrives — on every machine the claim delivers to, with no allowlist to carry there.
    open_inbound: ClassVar[bool] = True

    def __init__(self, binding: SourceBinding, hub: Optional[FlowHub] = None) -> None:
        super().__init__(binding)
        self._hub = hub

    @classmethod
    def build(cls, binding: SourceBinding) -> "FlowChannel":
        return cls(binding, hub=AppHub())

    @classmethod
    async def profile(cls) -> dict:
        """The channel as its setup card shows it. Whether the hub has this channel is learned at Connect."""
        return {"available": True, "name": PLATFORM_NAME, "number": "", "avatar": ""}

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

    @property
    def claim_id(self) -> str:
        return str(self.config.get("claim_id") or "")

    # ── what a channel driver owns ───────────────────────────────────────────
    def items_of(self, payload: dict) -> list[dict]:
        """The messages in one vendor envelope the hub handed this channel, each as ``{id, sender, name, text,
        reply_to, at}`` — ``sender`` being the person who wrote it."""
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

    def platform_profile(self) -> UserProfile:
        """Who a message sent from here reads as on the channel: the platform's own account."""
        return UserProfile(origin=CloudOrigin(kind=self.origin_kind, namespace="flow", key="flow"), name=PLATFORM_NAME)

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
        """A live Connect code for this person: what to send from their account. ``check`` holds while one is live
        (or the account is already connected) — and SHOWS it, for the next question."""
        current = await self.hub.claim(self.claim_id) if self.claim_id else None
        live = current is not None and (current.get("status") == "active" or _unexpired(current))
        if check:
            if not live:
                return ReturnedValue.not_yet("no Connect code yet")
            return ReturnedValue.satisfied("a Connect code is live", value=SourceUpdateSpec(shown=self._shown(current)), ran=False)
        try:
            minted = await self.hub.connect(self.channel, self._target())
        except Exception as exc:  # noqa: BLE001 — the hub's own words (e.g. it has no such channel)
            return ReturnedValue.not_yet(str(getattr(exc, "reason", "") or exc))
        if not minted.get("id"):
            return ReturnedValue.not_yet("The hub did not give a Connect code — try again.")
        return ReturnedValue.satisfied(
            "a Connect code is ready",
            value=SourceUpdateSpec(config={"claim_id": str(minted["id"])}, shown=self._shown(minted)),
        )

    @setup_step("connected")
    async def _connected(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue:
        """The gate: the hub validated the code from the person's account. Until then this says why not."""
        claim = await self.hub.claim(self.claim_id) if self.claim_id else None
        if claim is None:
            return ReturnedValue.not_yet(f"Press {self.connect_label} first.")
        if claim.get("status") != "active":
            if not _unexpired(claim):
                return ReturnedValue.not_yet(f"That code has expired — go back and press {self.connect_label} again.")
            return ReturnedValue.not_yet(f"Not connected yet — send the message from your {self.noun or self.title}.")
        sender = self.sender_of(claim.get("sender"))
        shown = self.display_sender(sender)
        if check:
            done = self.linked_sender == sender
            return ReturnedValue.satisfied(f"connected {shown}", ran=False) if done else ReturnedValue.not_yet("not kept yet")
        return ReturnedValue.satisfied(
            f"Connected {shown}",
            value=SourceUpdateSpec(config={self.identity_config_key: sender}, allowed_senders=[sender]),
        )

    async def verify(self) -> Verdict:
        """Connected NOW: the hub holds this source's claim, active, for its linked sender (the ``connected`` gate,
        asked). What every view reads, kept fresh by the poll."""
        answer = await self._connected(check=True, values={})
        return Verdict(ready=answer.ok, detail=answer.detail)

    def _shown(self, claim: dict) -> SetupShown:
        url = str(claim.get("deep_link") or "")
        return SetupShown(
            name=PLATFORM_NAME,
            code=str(claim.get("code") or ""),
            link=url,
            qr=_qr(url) if url else "",
            connected=claim.get("status") == "active",
        )

    # ── read ────────────────────────────────────────────────────────────────
    def query(self) -> MessageQuery:
        return MessageQuery()

    def _target(self) -> dict:
        """Where the hub hands this conversation: THIS instance, THIS channel."""
        try:
            from flow_sdk.instance_settings.runtime import instance_uid  # noqa: PLC0415

            instance = instance_uid()
        except Exception:  # noqa: BLE001 — no instance id: the hub refuses the target and Connect says why
            instance = ""
        return {"instance_id": instance, "data_source_id": str(self.binding.source_id or "")}

    # ── inbound: what the hub hands this channel ─────────────────────────────
    def events_from_webhook(self, payload: Any) -> list[DataSourceEvent]:
        """One message of this person's conversation, in the vendor's own envelope. Total: anything else yields
        nothing. Only THIS source's account: a person may hold an older source that never connected."""
        if not isinstance(payload, dict):
            return []
        mine = self.linked_sender
        events: list[DataSourceEvent] = []
        for message in self.items_of(payload):
            item = self._item(message)
            if item is not None and (not mine or item.data.conversation.key == mine):
                events.append(DataSourceEvent(id=item.origin.key, kind=EventKind.UPSERT, origin=item.origin, item=item))
        return events

    def _item(self, message: dict) -> Optional[MessageItem]:
        message_id = str(message.get("id") or "").strip()
        sender = self.sender_of(message.get("sender"))
        text = str(message.get("text") or "")
        if not (message_id and sender and text):
            return None
        author = UserProfile(origin=self.conversation_origin(sender), name=message.get("name") or None)
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
        """The person IS the conversation, and ``in_reply_to`` quotes their message. The claim reaches only the
        linked account, so that account is the default recipient. A subject has no equivalent."""
        sender = self.sender_of(to) or self.sender_of(thread_key) or self.linked_sender
        if not sender:
            raise ValueError(f"a {self.title} send needs the linked account")
        quoted = str(in_reply_to or "").strip()
        if quoted:
            return MessageData(text=text), self.message_origin(quoted, sender)
        return MessageData(text=text, conversation=self.conversation_origin(sender)), None

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        if data.attachments:
            raise Unsupported(f"{self.title} on the platform's account sends text")
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
        if sender != self.linked_sender or not self.claim_id:
            raise NotFound(f"only the linked {self.title} account is reached here")
        body = await self.hub.reply(self.claim_id, data.text or "", quoted)
        message_id = str(body.get("message_id") or "")
        if not message_id:
            raise OutcomeUnknown("the hub accepted the message but returned no id for it")
        sent = MessageData(
            text=data.text,
            conversation=self.conversation_origin(sender),
            sender=self.platform_profile(),
            sent_at=datetime.now(timezone.utc),
        )
        return MessageItem(origin=self.message_origin(message_id, sender), data=sent)


def unix_time(value: Any) -> Optional[datetime]:
    """A vendor's unix seconds (a number or its string), or None."""
    try:
        return datetime.fromtimestamp(float(str(value)), tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def _unexpired(claim: dict) -> bool:
    try:
        return float(claim.get("code_expires_at") or 0) > datetime.now(timezone.utc).timestamp()
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


__all__ = ["AppHub", "CLAIM_ENTITY", "FlowChannel", "FlowChannelConfig", "FlowHub", "MESSAGES_STREAM", "unix_time"]
