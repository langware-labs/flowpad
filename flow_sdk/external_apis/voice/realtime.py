"""A realtime voice call on OpenAI's Realtime API, held from the server — the call's control channel.

The provider carries the audio (a SIP leg from a phone carrier, or a browser's WebRTC peer); this
process holds only JSON: the call is accepted with a session (instructions, voice, the one tool),
and a **sideband** socket (``/v1/realtime?call_id=…``) is opened on it. What comes down that socket
is translated to :class:`CallEvent` — the rest of the runtime never reads a provider event name.

**The agent is the brain.** The voice model talks; anything that needs knowledge, records or an
action it asks for through one function tool, ``ask_agent``. That surfaces as a ``delegate`` event;
the runtime runs it as an ordinary agent turn and hands the answer back with :meth:`resolve`, which
the model then says. So the same agent — same process, same memory — answers the phone and the chat.

**Calls are created with the real key, server side.** A browser's SDP offer is posted by the
server (``calls.create``), and the answer and the call id (the ``Location`` header) are handed back.
The key never reaches the browser, and the sideband is always opened on a call this key made.
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Callable, Mapping, Optional

from websockets.exceptions import ConnectionClosed

from flow_sdk.sources.values.call import CallEvent, IncomingCall

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "gpt-realtime-2.1"
DEFAULT_VOICE = "marin"
#: The caller's own words, transcribed alongside the conversation — the ``heard`` sentences.
TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe"
#: The one tool the voice has: hand a request to the agent.
ASK_AGENT = "ask_agent"
ASK_AGENT_TOOL: dict = {
    "type": "function",
    "name": ASK_AGENT,
    "description": (
        "Ask the agent you speak for. Use it for anything that needs knowledge, records, tools or a "
        "decision — never guess those. Say a short filler first ('one moment'), then speak its answer."
    ),
    "parameters": {
        "type": "object",
        "properties": {"request": {"type": "string", "description": "What the caller wants, in full."}},
        "required": ["request"],
    },
}

#: Provider event → what it means on a call. Everything else on the socket is the model's own business.
_KINDS = {
    "conversation.item.input_audio_transcription.completed": "heard",
    "conversation.item.input_audio_transcription.delta": "partial",
    "response.output_audio_transcript.done": "said",
    "response.function_call_arguments.done": "delegate",
}


def event_of(event: Mapping[str, Any]) -> Optional[CallEvent]:
    """One sideband event as a call event, or ``None`` for one the runtime does not act on."""
    kind = _KINDS.get(str(event.get("type") or ""))
    if kind is None:
        return None
    if kind == "delegate":
        if event.get("name") not in (None, ASK_AGENT):
            return None
        try:
            request = json.loads(event.get("arguments") or "{}").get("request", "")
        except (TypeError, ValueError):
            request = str(event.get("arguments") or "")
        return CallEvent(kind="delegate", text=str(request or ""), ask_id=str(event.get("call_id") or ""),
                         item_id=str(event.get("item_id") or ""))
    text = event.get("transcript") if kind in ("heard", "said") else event.get("delta")
    text = str(text or "").strip() if kind != "partial" else str(text or "")
    if not text:
        return None
    return CallEvent(kind=kind, text=text, item_id=str(event.get("item_id") or ""))


def session_config(*, instructions: str, model: str = DEFAULT_MODEL, voice: str = DEFAULT_VOICE) -> dict:
    """The session every call runs with: the agent's voice instructions, both sides transcribed, one tool."""
    return {
        "type": "realtime",
        "model": model,
        "instructions": instructions,
        "audio": {
            # Turn detection is named, not left to the default: an update that carries ``input``
            # replaces it whole, and an input with no turn detection never hears the caller finish.
            "input": {"transcription": {"model": TRANSCRIBE_MODEL}, "turn_detection": {"type": "server_vad"}},
            "output": {"voice": voice},
        },
        "tools": [ASK_AGENT_TOOL],
    }


def client_for(api_key: str, *, base_url: str = ""):
    """The OpenAI client a call is held with. ``base_url`` points a test at a loopback double."""
    from openai import AsyncOpenAI  # noqa: PLC0415 — not imported until a call needs it

    return AsyncOpenAI(api_key=api_key, **({"base_url": base_url} if base_url else {}))


def incoming(payload: Mapping[str, Any]) -> Optional[IncomingCall]:
    """A ``realtime.call.incoming`` webhook as the call it rings, or ``None`` for any other event.

    The SIP ``From`` is the caller and ``To`` the number they dialled — the account a source is found by.
    """
    if payload.get("type") != "realtime.call.incoming":
        return None
    data = payload.get("data") or {}
    headers = {str(h.get("name", "")).lower(): str(h.get("value", "")) for h in data.get("sip_headers") or []}
    return IncomingCall(
        call_id=str(data.get("call_id") or ""),
        caller=sip_user(headers.get("from", "")),
        dialed=sip_user(headers.get("to", "")),
        caller_name=sip_display(headers.get("from", "")),
    )


def sip_user(value: str) -> str:
    """``"Ada" <sip:+14155550100@host>;tag=x`` → ``+14155550100``."""
    text = value.split("<", 1)[1].split(">", 1)[0] if "<" in value else value
    text = text.split(";", 1)[0].strip()
    for scheme in ("sips:", "sip:", "tel:"):
        if text.lower().startswith(scheme):
            text = text[len(scheme):]
    return text.split("@", 1)[0].strip()


def sip_display(value: str) -> str:
    return value.split("<", 1)[0].strip().strip('"') if "<" in value else ""


def authentic(headers: Mapping[str, str], body: bytes, secret: str) -> bool:
    """Whether a webhook delivery is OpenAI's (Standard Webhooks signature over the raw body)."""
    if not secret:
        return False
    from openai import AsyncOpenAI  # noqa: PLC0415

    try:
        AsyncOpenAI(api_key="unused", webhook_secret=secret).webhooks.verify_signature(body, dict(headers), secret=secret)
    except Exception:  # noqa: BLE001 — any failure to verify is "not authentic"
        return False
    return True


async def create_browser_call(client, *, sdp: str, instructions: str, model: str = DEFAULT_MODEL,
                              voice: str = DEFAULT_VOICE) -> tuple[str, str]:
    """Create a WebRTC call from a browser's SDP offer: ``(sdp answer, call id)``."""
    raw = await client.realtime.calls.with_raw_response.create(
        sdp=sdp, session=session_config(instructions=instructions, model=model, voice=voice)
    )
    location = raw.headers.get("location") or ""
    call_id = location.rstrip("/").rsplit("/", 1)[-1]
    answer = raw.http_response.text
    if not call_id:
        raise RuntimeError("the provider answered the offer without a call id")
    return answer, call_id


async def accept(client, call: IncomingCall, *, instructions: str, model: str = DEFAULT_MODEL,
                 voice: str = DEFAULT_VOICE) -> None:
    """Accept a SIP call that rang through the webhook, with the call's session."""
    config = session_config(instructions=instructions, model=model, voice=voice)
    config.pop("type")
    await client.realtime.calls.accept(call.call_id, type="realtime", **config)


async def reject(client, call: IncomingCall) -> None:
    await client.realtime.calls.reject(call.call_id, status_code=603)


class RealtimeCallSession:
    """One accepted call's control channel — the ``CallSession`` for a realtime call.

    ``connect`` is the socket factory (``client.realtime.connect``); a test hands a scripted one.
    ``greet`` makes the voice speak first — a placed call must not open on silence.
    """

    def __init__(self, client, call_id: str, *, greet: str = "", connect: Optional[Callable[..., Any]] = None,
                 update: Optional[dict] = None):
        self.client = client
        self.call_id = call_id
        self._greet = greet
        self._connect = connect or (lambda: client.realtime.connect(call_id=call_id))
        self._update = update
        self._conn: Any = None
        #: The voice is speaking a response now; a new one must wait for it (the provider refuses two).
        self._responding = False
        #: Responses asked for while one was in progress, sent in order as each finishes.
        self._queued: list[dict] = []
        self._last: Optional[dict] = None

    async def events(self) -> AsyncIterator[CallEvent]:
        async with self._connect() as conn:
            self._conn = conn
            if self._update:
                await conn.send({"type": "session.update", "session": self._update})
            if self._greet:
                await self._respond({"instructions": self._greet})
            try:
                async for raw in conn:
                    payload = raw.model_dump() if hasattr(raw, "model_dump") else dict(raw)
                    kind = payload.get("type")
                    if kind == "response.created":
                        self._responding = True
                    elif kind == "response.done":
                        self._responding = False
                        if self._queued:
                            await self._respond(self._queued.pop(0))
                    if kind == "error":
                        error = payload.get("error") or {}
                        if error.get("code") == "conversation_already_has_active_response" and self._last is not None:
                            # The voice began a response of its own (the caller stopped talking) just as
                            # ours was sent: ours goes first in line behind it.
                            self._responding = True
                            self._queued.insert(0, self._last)
                            continue
                        logger.warning("[voice] call %s: provider error %s", self.call_id, error)
                        continue
                    event = event_of(payload)
                    if event is not None:
                        yield event
            except ConnectionClosed as exc:
                # The line went away without a goodbye (a browser tab closed, a phone dropped): that
                # is how calls end, not a failure of this one.
                logger.info("[voice] call %s: the provider closed the line (%s)", self.call_id, exc)
            finally:
                self._conn = None
        yield CallEvent(kind="ended")

    async def _respond(self, response: dict) -> None:
        """Ask the voice to speak — now, or right after the response it is speaking (a filler while
        the agent works is the common case: the agent's answer arrives mid-sentence)."""
        if self._conn is None:
            return
        if self._responding:
            self._queued.append(response)
            return
        self._responding = True  # claimed until the provider says otherwise; two sends must not race
        self._last = response
        await self._conn.send({"type": "response.create", **({"response": response} if response else {})})

    async def resolve(self, ask_id: str, answer: str) -> None:
        if self._conn is None:
            return
        await self._conn.send({"type": "conversation.item.create",
                               "item": {"type": "function_call_output", "call_id": ask_id, "output": answer}})
        await self._respond({})

    async def say(self, text: str) -> None:
        await self._respond({"instructions": f"Say exactly this, nothing more: {text}"})

    async def hangup(self) -> None:
        try:
            await self.client.realtime.calls.hangup(self.call_id)
        except Exception:  # noqa: BLE001 — a call already gone is hung up
            logger.debug("[voice] hangup of %s failed", self.call_id, exc_info=True)


__all__ = [
    "ASK_AGENT",
    "ASK_AGENT_TOOL",
    "DEFAULT_MODEL",
    "DEFAULT_VOICE",
    "RealtimeCallSession",
    "accept",
    "authentic",
    "client_for",
    "create_browser_call",
    "event_of",
    "incoming",
    "reject",
    "session_config",
    "sip_user",
]
