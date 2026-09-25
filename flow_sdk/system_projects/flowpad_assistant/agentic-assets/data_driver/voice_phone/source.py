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
to its dial (``_dialled``) by the token its TwiML stamps on the leg (``X-Flow-Dial``), which gives the
callee and what the call is for — exactly that dial's, so one that never connected is never mistaken
for the next call on the line.
"""
from __future__ import annotations

import secrets
from typing import Any, ClassVar, Mapping, Optional
from urllib.parse import quote
from xml.sax.saxutils import escape

from flow_sdk.external_apis.voice import realtime
from flow_sdk.sources import http
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.credentials import Credentials
from flow_sdk.sources.errors import AccessDenied, Rejected, SourceError
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.call import IncomingCall
from flow_sdk.sources.values.items import MessageItem
from flow_sdk.sources.voice import VoiceChannel

TWILIO_API = "https://api.twilio.com"
OPENAI_SIP_HOST = "sip.api.openai.com"
#: The header our TwiML stamps on the SIP leg: which of our numbers the call is on.
NUMBER_HEADER = "X-Flow-Number"
#: The header a dial's TwiML stamps on its leg: which of our dials this ring-back answers.
DIAL_HEADER = "X-Flow-Dial"


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

    #: Calls we dialled and OpenAI has not rung back yet, by dial token: (callee, what it is for).
    _dialled: ClassVar[dict[str, tuple[str, str]]] = {}

    def _model(self) -> str:
        return str(self.config.get("model") or "").strip() or realtime.DEFAULT_MODEL

    def _voice(self) -> str:
        return str(self.config.get("voice") or "").strip() or realtime.DEFAULT_VOICE

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        """The four keys resolve and the number is on the Twilio account (one
        ``GET …/IncomingPhoneNumbers.json?PhoneNumber=``). What cannot be checked from here is said:
        OpenAI's SIP webhook must reach this instance."""
        try:
            self.api_key()
        except AccessDenied as exc:
            return Verdict(ready=False, detail=str(exc))
        missing = [n for n in ("OPENAI_WEBHOOK_SECRET", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN") if not self.secret(n)]
        if missing:
            return Verdict(ready=False, detail=f"Set {', '.join(missing)} — the line cannot run without them.")
        if not str(self.config.get("project") or "").strip():
            return Verdict(ready=False, detail="No OpenAI project yet — name the project whose SIP connector takes the calls.")
        account, auth = self._twilio()
        try:
            async with http.client() as client:
                body = await http.request_json(
                    client, "GET", f"{account}/IncomingPhoneNumbers.json",
                    params={"PhoneNumber": self.account}, auth=auth, hint="Twilio refused the lookup",
                )
        except AccessDenied:
            return Verdict(ready=False, detail="Twilio refused TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN.")
        except SourceError as exc:
            return Verdict(ready=False, detail=f"Twilio refused the request: {exc}")
        if not (body or {}).get("incoming_phone_numbers"):
            return Verdict(ready=False, detail=f"{self.account} is not a number on this Twilio account.")
        return Verdict(ready=True, detail=f"Calls on {self.account}. Point the OpenAI project's SIP webhook at "
                                          "/api/v1/data_source/webhook/voice_phone on this instance — it cannot be checked from here.")

    # ── the webhooks ────────────────────────────────────────────────────────
    @classmethod
    def webhook_account(cls, payload: dict) -> str:
        if _is_carrier(payload):
            return str(payload.get("To") or "")
        headers = _sip_headers(payload)
        if headers.get(NUMBER_HEADER.lower()):
            return realtime.sip_user(headers[NUMBER_HEADER.lower()])
        caller, dialled = realtime.sip_user(headers.get("from", "")), realtime.sip_user(headers.get("to", ""))
        # A call we placed comes FROM our number (its leg carries our dial token); one placed to us was dialled TO it.
        return caller if headers.get(DIAL_HEADER.lower()) in cls._dialled else dialled

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
        dial_token = _sip_headers(payload).get(DIAL_HEADER.lower(), "")
        placed = self._dialled.pop(dial_token, None)
        if placed is not None:
            callee, brief = placed
            return [call.model_copy(update={"caller": callee, "dialed": self.account, "brief": brief, "caller_name": "",
                                            "conversation": dial_token})]
        return [call.model_copy(update={"dialed": self.account})]

    # ── the call ────────────────────────────────────────────────────────────
    async def start_call(self, offer: Any) -> "tuple[dict, Optional[IncomingCall]]":
        """Dial ``offer.to``; OpenAI rings back through the webhook once the person answers."""
        offer = dict(offer or {})
        to = str(offer.get("to") or "").strip()
        if not to.startswith("+"):
            raise ValueError("a phone call needs the number to dial, E.164 (+972…)")
        return await self.dial(to, brief=str(offer.get("brief") or "").strip()), None

    def _twilio(self) -> "tuple[str, tuple[str, str]]":
        """The Twilio account's API root and its basic auth."""
        sid, token = self.secret("TWILIO_ACCOUNT_SID"), self.secret("TWILIO_AUTH_TOKEN")
        if not (sid and token):
            raise Rejected("no Twilio credentials — set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN")
        base = str(self.config.get("twilio_base_url") or TWILIO_API).rstrip("/")
        return f"{base}/2010-04-01/Accounts/{sid}", (sid, token)

    async def dial(self, to: str, *, brief: str = "") -> dict:
        account, auth = self._twilio()
        dial = secrets.token_hex(8)
        self._dialled[dial] = (to, brief)
        async with http.client() as client:
            response = await http.request(
                client, "POST", f"{account}/Calls.json", auth=auth,
                data={"To": to, "From": self.account,
                      "Twiml": bridge(str(self.config.get("project") or ""), self.account, dial=dial)},
                hint="Twilio refused the call",
            )
        body = response.json()
        return {"call_sid": str(body.get("sid") or ""), "status": str(body.get("status") or ""), "to": to, "dial": dial}

    async def accept(self, call: IncomingCall, *, instructions: str):
        client = self.client()
        await realtime.accept(client, call, instructions=instructions, model=self._model(), voice=self._voice())
        greet = "Open the call now, as your instructions say." if call.brief else "Greet the caller in one short sentence."
        session = realtime.RealtimeCallSession(client, call.call_id, greet=greet)
        return self.hold(call, session)

    async def reject(self, call: IncomingCall) -> None:
        await realtime.reject(self.client(), call)

    async def say_to(self, person: str, text: str) -> MessageItem:
        """Into their live call when they are on one; otherwise call them, with ``text`` as the call's purpose."""
        said = await self.say_live(person, text)
        if said is not None:
            return said
        placed = await self.dial(person, brief=text)
        return self.said(person, f"Calling {person}: {text}", f"dial-{placed['call_sid'] or placed['dial']}", call=placed["dial"])


def bridge(project: str, number: str, *, dial: str = "") -> str:
    """TwiML that bridges the call to OpenAI's SIP connector, naming our number (and, for a call we
    placed, which dial it is) on the leg."""
    if not project:
        raise Rejected("this phone line names no OpenAI project; set it first")
    uri = f"sip:{project}@{OPENAI_SIP_HOST};transport=tls?{NUMBER_HEADER}={quote(number)}"
    if dial:
        uri += f"&{DIAL_HEADER}={quote(dial)}"
    return f'<Response><Dial answerOnBridge="true"><Sip>{escape(uri)}</Sip></Dial></Response>'


def _is_carrier(payload: Any) -> bool:
    return isinstance(payload, dict) and "CallSid" in payload


def _sip_headers(payload: Any) -> dict[str, str]:
    data = (payload or {}).get("data") or {} if isinstance(payload, dict) else {}
    return {str(h.get("name", "")).lower(): str(h.get("value", "")) for h in data.get("sip_headers") or []}
