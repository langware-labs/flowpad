"""WhatsApp — a business number on Meta's Cloud API.

**This driver does not poll, because there is nothing to poll.** The Cloud API
has no endpoint that lists messages: inbound arrives as a webhook POST from
Meta, once, and if you drop it it is gone. So ``fetch`` deliberately reports
``unchanged`` forever, and the records are produced by the webhook route
(``server/routes/whatsapp.py``) calling ``items_from_webhook`` here and handing
the result to ``ingest_items`` — the same chokepoint the poller writes through,
and the same one ``flow record create`` uses. The driver still owns the message
SHAPE; only the trigger moved.

Three more facts the code respects:

* **A business number sees no echo of itself.** Our own outbound comes back
  through the webhook as a `statuses` entry — a delivery receipt, not a message
  — so nothing will ever re-deliver the sent copy. ``send`` therefore records
  it itself (``recorded=True``), the way Telegram does and unlike Slack, or the
  inbox would show only the human's half of the conversation.
* **WhatsApp has no threads.** The conversation IS the pair (business number,
  person), so ``thread_key`` is the person's ``wa_id``. A quoted message rides
  ``context.id`` and becomes ``reply_to_external_id`` — provenance, not
  threading.
* **The 24-hour window.** A free-form reply is only allowed within 24h of the
  person's last message; outside it Meta accepts nothing but a pre-approved
  template. An agent answering a message is inside the window by construction,
  so this driver sends plain text and lets Meta's own error surface when a
  reply arrives too late — inventing a template here would be guessing at
  content nobody approved.

Config on the DataSource::

    {"phone_number_id": "123456789",      # the business number's Graph id
     "access_token": "EAAG...",           # provider-opaque, like telegram's bot_token
     "verify_token": "whatever-you-set"}  # echoed back during webhook setup
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.driver import (
    FetchResult,
    IngestDriver,
    SegmentCursorView,
    SegmentRef,
    SendOutcome,
    SendStatus,
    SetupVerdict,
)
from flow_sdk.ingest.health import SourceError

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.source_item import MessageSpec

logger = logging.getLogger(__name__)

#: Graph's base. Overridable only so a test can point at a local double.
GRAPH_API_BASE = "https://graph.facebook.com"

#: Pinned deliberately. Meta versions the whole surface and deprecates old ones
#: on a schedule, so the version is a fact about this driver, not a default to
#: inherit from whatever Meta is serving today.
GRAPH_VERSION = "v23.0"

#: The one stream. A source is ABOUT one business number, and every
#: conversation on it arrives through the same webhook — there is no per-chat
#: subscription to make segments out of.
MESSAGES_SEGMENT = "messages"

#: Message types this driver turns into records. Everything else (a reaction,
#: an order, a system notice) is a real event that nobody wrote as a sentence,
#: and rendering it in a conversation would put a line in the inbox from no one.
_TEXTUAL = {"text", "button", "interactive"}


class WhatsAppDriver(IngestDriver):
    provider = "whatsapp"
    kind = "datasource.api.whatsapp"
    #: `content.message.*` is what the inbox projection accepts, so a WhatsApp
    #: record lands in a conversation exactly like an email or a Slack post.
    record_kind = "content.message.chat"

    #: `POST /{phone_number_id}/messages` is the send leg.
    sends = True
    #: A WhatsApp source is ABOUT one business number.
    identity_config_key = "phone_number_id"

    @classmethod
    def outbound_spec(cls, source) -> type["MessageSpec"]:
        from flow_sdk.builtin.source_item import WhatsAppMessageSpec  # noqa: PLC0415

        return WhatsAppMessageSpec

    def channel_for(self, source) -> str:
        return "whatsapp"

    async def segments(self, source) -> list[SegmentRef]:
        return [SegmentRef(key=MESSAGES_SEGMENT, label=str(self._config(source).get("phone_number_id") or ""))]

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        """Nothing, always — and that is the contract, not a stub.

        Meta publishes no endpoint that lists messages; the only delivery is the
        webhook. Polling would therefore be a request that cannot return a
        message no matter how often it runs, so this reports ``unchanged`` and
        costs nothing. Records reach the inbox through
        ``server/routes/whatsapp.py`` → ``items_from_webhook`` → ``ingest_items``.
        """
        return FetchResult(items=[], next_state=dict(cursor.state or {}), unchanged=True)

    async def verify(self, source) -> SetupVerdict:
        """Does the token actually address this business number?

        One `GET /{phone_number_id}` — the cheapest question with the right
        answer: a wrong id 404s, a bad or expired token 401s, and a token for a
        DIFFERENT business fails on the id rather than quietly sending from
        somewhere else.
        """
        config = self._config(source)
        phone_number_id = str(config.get("phone_number_id") or "").strip()
        token = str(config.get("access_token") or "").strip()
        if not phone_number_id:
            return SetupVerdict.waiting("No business number yet — paste the phone number ID from the Meta app.")
        if not token:
            return SetupVerdict.waiting("No access token yet — paste one from the Meta app's WhatsApp setup.")

        try:
            body = await self._request(source, "GET", phone_number_id, params={"fields": "display_phone_number"})
        except SourceError as exc:
            if exc.code == "unauthorized":
                return SetupVerdict.waiting(
                    "Meta refused the token. A temporary token from the setup page expires in 24 hours — "
                    "create a System User token for one that does not."
                )
            return SetupVerdict.waiting(f"Meta refused the request: {exc}")

        number = str(body.get("display_phone_number") or "").strip()
        await self._stamp_identity(source, phone_number_id, number)
        return SetupVerdict.ok(f"Sending as {number or phone_number_id}. Point Meta's webhook at this instance.")

    async def send(
        self,
        source,
        *,
        thread_key: str,
        to: str,
        text: str,
        subject: str = "",
        conversation_id: str = "",
        in_reply_to: str = "",
    ) -> SendOutcome:
        """Send to a person, and record the sent copy ourselves.

        ``to`` is the person's ``wa_id`` — their phone number in international
        digits, which is also ``thread_key``, because the conversation IS the
        pair. ``in_reply_to`` quotes their message through Meta's ``context``,
        which renders as a quote in the client but does NOT start a thread;
        WhatsApp has none. ``subject`` has no equivalent and is ignored by
        design rather than smuggled into the text.

        Raises ``ValueError`` (never ``SourceError``) on a refused send: one
        failed reply must not park the number's ingestion.
        """
        wa_id = _digits(to) or _digits(thread_key)
        if not wa_id:
            raise ValueError("a whatsapp send needs the recipient's wa_id in `to`")
        if not (text or "").strip():
            raise ValueError("a whatsapp send needs text")

        config = self._config(source)
        phone_number_id = str(config.get("phone_number_id") or "").strip()
        if not phone_number_id:
            raise ValueError("this source has no phone_number_id; verify it first")

        payload: dict[str, Any] = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": wa_id,
            "type": "text",
            "text": {"body": text},
        }
        quoted = str(in_reply_to or "").strip()
        if quoted:
            payload["context"] = {"message_id": quoted}

        try:
            body = await self._request(source, "POST", f"{phone_number_id}/messages", json_body=payload)
        except SourceError as exc:
            raise ValueError(f"WhatsApp refused the message: {exc}") from exc

        sent_id = str(((body.get("messages") or [{}])[0]).get("id") or "")
        # Our own outbound never comes back as a MESSAGE — only as a delivery
        # `status` — so this is the one copy we will ever see. Recording it is
        # what keeps our half of the conversation in the thread.
        recorded = False
        if sent_id:
            item = SourceItemSpec(
                data_source_id=source.id,
                provider=self.provider,
                kind=self.record_kind,
                segment_key=MESSAGES_SEGMENT,
                segment_label=wa_id,
                external_id=sent_id,
                name="",
                body=text,
                occurred_at=datetime.now(timezone.utc).isoformat(),
                author_external_id=phone_number_id,
                thread_key=wa_id,
                reply_to_external_id=quoted or None,
                raw=body,
            )
            try:
                from flow_sdk.ingest.ingestor import ingest_items  # noqa: PLC0415

                await ingest_items([item])
                recorded = True
            except Exception:  # noqa: BLE001 — it IS delivered; bookkeeping must not unsend it
                logger.exception("[whatsapp] sent %s but could not record the copy", sent_id)

        return SendOutcome(external_id=sent_id, status=SendStatus.SENT, recorded=recorded)

    # ── internals ─────────────────────────────────────────────────────────

    def _config(self, source) -> dict:
        return getattr(source, "config", None) or {}

    async def _stamp_identity(self, source, phone_number_id: str, display_number: str) -> None:
        """Stamp the business number's own ids onto the source, once.

        ``self_addresses`` reads ``account_identities``, and the copies ``send``
        records carry ``phone_number_id`` as their author — without it stamped
        here the inbox would attribute our own replies to a foreign sender and
        an agent loop would answer itself.
        """
        if getattr(source, "account_key", "") or getattr(source, "account_identities", None):
            return
        source.account_key = display_number or phone_number_id
        source.account_identities = [v for v in (phone_number_id, _digits(display_number)) if v]
        await source.save()

    async def _request(
        self,
        source,
        verb: str,
        path: str,
        *,
        params: Optional[dict] = None,
        json_body: Optional[dict] = None,
    ) -> dict:
        """One Graph call with the provider's shared failure translation."""
        import httpx  # noqa: PLC0415

        from flow_sdk.ingest.http import REQUEST_TIMEOUT_SECONDS  # noqa: PLC0415

        token = str(self._config(source).get("access_token") or "").strip()
        if not token:
            raise SourceError.config("no_credential", "This WhatsApp source has no access token.")

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response = await client.request(
                    verb,
                    f"{GRAPH_API_BASE}/{GRAPH_VERSION}/{path}",
                    headers={"Authorization": f"Bearer {token}"},
                    params=params,
                    json=json_body,
                )
        except httpx.HTTPError as exc:
            raise SourceError.transient("network_error", str(exc)) from exc

        if response.status_code in {429, 500, 502, 503, 504}:
            raise SourceError.transient(f"http_{response.status_code}", f"Meta: {response.status_code}")
        try:
            body = response.json() if response.content else {}
        except ValueError as exc:
            raise SourceError.transient("bad_json", str(exc)) from exc
        if response.status_code >= 400:
            error = (body.get("error") or {}) if isinstance(body, dict) else {}
            code = "unauthorized" if response.status_code in {401, 403} else f"http_{response.status_code}"
            raise SourceError.config(code, str(error.get("message") or f"HTTP {response.status_code}"))
        return body if isinstance(body, dict) else {}


def _digits(value: Any) -> str:
    """A wa_id is a phone number in international digits — no `+`, no spaces.

    Normalised on the way in AND on the way out, because the same number
    reaches us written three ways: Meta sends `972501234567`, a person types
    `+972-50-123-4567`, and a reply target carries whichever of those was
    stored. Two spellings of one correspondent would fork the conversation.
    """
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def items_from_webhook(source, payload: dict) -> list[SourceItemSpec]:
    """Meta's webhook body → the records it describes.

    A pure function, deliberately: it is the whole translation, and a route
    that has to spin up a server to be tested is a translation nobody tests.
    Never raises on a shape it does not recognise — Meta posts the same
    envelope for delivery receipts, account alerts and message types this
    driver does not render, and a webhook that 500s gets RETRIED, so refusing
    to parse one field would replay the whole batch forever.
    """
    items: list[SourceItemSpec] = []
    for entry in _list(payload.get("entry")):
        for change in _list(entry.get("changes")):
            value = change.get("value") if isinstance(change.get("value"), dict) else {}
            # `statuses` is the delivery-receipt lane — sent/delivered/read for
            # messages WE sent. Real events, but nobody wrote them, and each
            # one would land in the inbox as a line from no one.
            if not value.get("messages"):
                continue
            names = {
                _digits(c.get("wa_id")): str((c.get("profile") or {}).get("name") or "")
                for c in _list(value.get("contacts"))
                if isinstance(c, dict)
            }
            for message in _list(value.get("messages")):
                item = _item_from_message(source, message, names)
                if item is not None:
                    items.append(item)
    return items


def _item_from_message(source, message: dict, names: dict[str, str]) -> Optional[SourceItemSpec]:
    message_id = str(message.get("id") or "").strip()
    wa_id = _digits(message.get("from"))
    if not (message_id and wa_id):
        return None
    kind = str(message.get("type") or "")
    if kind not in _TEXTUAL:
        return None
    body = _text_of(message, kind)
    if not body:
        return None
    return SourceItemSpec(
        data_source_id=source.id,
        provider=WhatsAppDriver.provider,
        kind=WhatsAppDriver.record_kind,
        segment_key=MESSAGES_SEGMENT,
        segment_label=wa_id,
        # Meta's `wamid.…` is globally unique, so it is already the natural key.
        external_id=message_id,
        name="",
        body=body,
        occurred_at=_iso(message.get("timestamp")),
        author_external_id=wa_id,
        author_display=names.get(wa_id) or None,
        # The conversation IS the pair, so the person is the thread. WhatsApp
        # has no threads to derive one from.
        thread_key=wa_id,
        # A quote is provenance, not membership — `context.id` says which
        # message was quoted and changes nothing about which conversation
        # this belongs to.
        reply_to_external_id=str((message.get("context") or {}).get("id") or "") or None,
        raw=message,
    )


def _text_of(message: dict, kind: str) -> str:
    """The words, whichever shape carried them.

    A tap on a reply button is a person answering, and it arrives as
    `button`/`interactive` rather than `text` — dropping those would make the
    conversation lose exactly the turns a bot's own prompts invited.
    """
    if kind == "text":
        return str((message.get("text") or {}).get("body") or "").strip()
    if kind == "button":
        return str((message.get("button") or {}).get("text") or "").strip()
    interactive = message.get("interactive") or {}
    for shape in ("button_reply", "list_reply"):
        reply = interactive.get(shape) or {}
        if reply.get("title"):
            return str(reply["title"]).strip()
    return ""


def _iso(timestamp: Any) -> str:
    """Meta sends unix seconds as a STRING; the inbox stores ISO-8601 UTC."""
    try:
        return datetime.fromtimestamp(int(str(timestamp)), tz=timezone.utc).isoformat()
    except (TypeError, ValueError):
        return datetime.now(timezone.utc).isoformat()


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []
