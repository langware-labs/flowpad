"""``VoicePhoneSource`` — a phone number the agent answers and calls from.

**Twilio carries the line; OpenAI holds the voice.** Every call — one someone places to the number,
or one the agent places — is bridged by Twilio to OpenAI Realtime's SIP connector
(``<Dial><Sip>sip:<project>@sip.api.openai.com``). OpenAI then rings this instance by webhook
(``realtime.call.incoming``); the runtime accepts it and holds its control channel. No audio ever
passes through this process.

Two webhooks reach ``/api/v1/data_source/webhook/voice_phone``, told apart by their shape:

* **Twilio's** (a form, for a call to the number) asks what to do with the call. The answer is
  TwiML bridging it to OpenAI (``webhook_reply``); it ingests nothing and drives nothing, which is
  why it needs no signature — the worst a forger gets is a call bridged to our own voice.
* **OpenAI's** (JSON, Standard Webhooks signature under ``OPENAI_WEBHOOK_SECRET``) rings the call.

**Who is on the line.** The SIP leg names our number in a header we set (``X-Flow-Number``) when
the provider passes it, else by the ``From`` of a call we dialled. A call the agent placed is matched
to its dial (``_dialled``) by our number, which gives the callee and what the call is for.
"""
from __future__ import annotations

import secrets
from collections import deque
from typing import Any, ClassVar, Mapping, Optional
from urllib.parse import quote
from xml.sax.saxutils import escape

from flow_sdk.external_apis.voice import realtime
from flow_sdk.sources import http
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.credentials import Credentials
from flow_sdk.sources.errors import Rejected
from flow_sdk.sources.values.call import IncomingCall
from flow_sdk.sources.values.items import MessageItem
from flow_sdk.sources.voice import VoiceChannel

TWILIO_API = "https://api.twilio.com"
OPENAI_SIP_HOST = "sip.api.openai.com"
#: The header our TwiML stamps on the SIP leg: which of our numbers the call is on.
NUMBER_HEADER = "X-Flow-Number"


class VoicePhoneConfig(SourceConfig):
    """What a phone line is configured with. Its keys are the credential's, never here."""

    number: str
    #: The OpenAI project whose SIP connector the calls are bridged to (``proj_…``).
    project: str
    voice: str = ""
    model: str = ""
    #: API roots. Empty means the providers' own; a test names loopback doubles.
    base_url: str = ""
    twilio_base_url: str = ""


class VoicePhoneSource(VoiceChannel):

    Config = VoicePhoneConfig
    provider = "voice_phone"
    identity_config_key: ClassVar[str] = "number"

    #: Calls we dialled and OpenAI has not rung back yet, per our number: (callee, what it is for).
    _dialled: ClassVar[dict[str, deque]] = {}
    #: Calls on the line from this process, by the person: what ``say_to`` speaks into.
    _live: ClassVar[dict[str, Any]] = {}

    def _model(self) -> str:
        return str(self.config.get("model") or "").strip() or realtime.DEFAULT_MODEL

    def _voice(self) -> str:
        return str(self.config.get("voice") or "").strip() or realtime.DEFAULT_VOICE

    # ── the webhooks ────────────────────────────────────────────────────────
    @classmethod
    def webhook_account(cls, payload: dict) -> str:
        if _is_carrier(payload):
            return str(payload.get("To") or "")
        headers = _sip_headers(payload)
        if headers.get(NUMBER_HEADER.lower()):
            return realtime.sip_user(headers[NUMBER_HEADER.lower()])
        caller, dialled = realtime.sip_user(headers.get("from", "")), realtime.sip_user(headers.get("to", ""))
        # A call we placed comes FROM our number; one placed to us was dialled TO it.
        return caller if caller in cls._dialled else dialled

    @classmethod
    def webhook_authentic(cls, headers: Mapping[str, str], body: bytes, credentials: Credentials) -> bool:
        if "webhook-signature" in headers:
            stored = credentials.values.get("OPENAI_WEBHOOK_SECRET")
            return realtime.authentic(headers, body, stored.get_secret_value() if stored is not None else "")
        # A carrier's form asks only what to do with a call; it carries nothing that is ingested or answered.
        return body[:1] not in (b"{", b"[")

    @classmethod
    def webhook_reply(cls, payload: dict, config: Mapping[str, Any]) -> "Optional[tuple[str, str]]":
        """A call to the number: bridge it to OpenAI's SIP connector, stamped with our number."""
        if not _is_carrier(payload):
            return None
        return bridge(str(config.get("project") or ""), str(config.get("number") or "")), "application/xml"

    def events_from_webhook(self, payload: Any) -> list:
        return []

    def calls_from_webhook(self, payload: dict) -> list[IncomingCall]:
        call = realtime.incoming(payload) if not _is_carrier(payload) else None
        if call is None or not call.call_id:
            return []
        dialled = self._dialled.get(self.account)
        if call.caller == self.account and dialled:
            callee, brief = dialled.popleft()
            return [call.model_copy(update={"caller": callee, "dialed": self.account, "brief": brief, "caller_name": ""})]
        return [call.model_copy(update={"dialed": self.account})]

    # ── the call ────────────────────────────────────────────────────────────
    async def start_call(self, offer: Any) -> "tuple[dict, Optional[IncomingCall]]":
        """Dial ``offer.to``; OpenAI rings back through the webhook once the person answers."""
        offer = dict(offer or {})
        to = str(offer.get("to") or "").strip()
        if not to.startswith("+"):
            raise ValueError("a phone call needs the number to dial, E.164 (+972…)")
        return await self.dial(to, brief=str(offer.get("brief") or "").strip()), None

    async def dial(self, to: str, *, brief: str = "") -> dict:
        sid, token = self.secret("TWILIO_ACCOUNT_SID"), self.secret("TWILIO_AUTH_TOKEN")
        if not (sid and token):
            raise Rejected("no Twilio credentials — set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN")
        base = str(self.config.get("twilio_base_url") or TWILIO_API).rstrip("/")
        self._dialled.setdefault(self.account, deque()).append((to, brief))
        async with http.client() as client:
            response = await http.request(
                client, "POST", f"{base}/2010-04-01/Accounts/{sid}/Calls.json", auth=(sid, token),
                data={"To": to, "From": self.account, "Twiml": bridge(str(self.config.get("project") or ""), self.account)},
                hint="Twilio refused the call",
            )
        body = response.json()
        return {"call_sid": str(body.get("sid") or ""), "status": str(body.get("status") or ""), "to": to}

    async def accept(self, call: IncomingCall, *, instructions: str):
        client = self.client()
        await realtime.accept(client, call, instructions=instructions, model=self._model(), voice=self._voice())
        greet = "Open the call now, as your instructions say." if call.brief else "Greet the caller in one short sentence."
        session = realtime.RealtimeCallSession(client, call.call_id, greet=greet)
        type(self)._live[call.caller] = session
        return _Forgetting(session, lambda: type(self)._live.pop(call.caller, None))

    async def reject(self, call: IncomingCall) -> None:
        await realtime.reject(self.client(), call)

    async def say_to(self, person: str, text: str) -> MessageItem:
        """Into their live call when they are on one; otherwise call them, with ``text`` as the call's purpose."""
        session = type(self)._live.get(person)
        if session is not None:
            await session.say(text)
            return self.said(person, text, f"say-{secrets.token_hex(6)}")
        placed = await self.dial(person, brief=text)
        return self.said(person, f"Calling {person}: {text}", f"dial-{placed.get('call_sid') or secrets.token_hex(6)}")


def bridge(project: str, number: str) -> str:
    """TwiML that bridges the call to OpenAI's SIP connector, naming our number on the leg."""
    if not project:
        raise Rejected("this phone line names no OpenAI project; set it first")
    uri = f"sip:{project}@{OPENAI_SIP_HOST};transport=tls?{NUMBER_HEADER}={quote(number)}"
    return f'<Response><Dial answerOnBridge="true"><Sip>{escape(uri)}</Sip></Dial></Response>'


def _is_carrier(payload: Any) -> bool:
    return isinstance(payload, dict) and "CallSid" in payload


def _sip_headers(payload: Any) -> dict[str, str]:
    data = (payload or {}).get("data") or {} if isinstance(payload, dict) else {}
    return {str(h.get("name", "")).lower(): str(h.get("value", "")) for h in data.get("sip_headers") or []}


class _Forgetting:
    """A call session that forgets its person's line when the call ends."""

    def __init__(self, session, forget):
        self._session, self._forget = session, forget

    async def events(self):
        try:
            async for event in self._session.events():
                yield event
        finally:
            self._forget()

    async def resolve(self, ask_id: str, answer: str) -> None:
        await self._session.resolve(ask_id, answer)

    async def say(self, text: str) -> None:
        await self._session.say(text)

    async def hangup(self) -> None:
        await self._session.hangup()
