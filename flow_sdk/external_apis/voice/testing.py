"""``FakeRealtime`` — OpenAI's Realtime calls, sideband socket and audio endpoints on a loopback port.

A voice source is tested against this the way a mail source is tested against a loopback IMAP: the
real SDK talks to it (``base_url``), so the call is created, accepted, held and hung up through the
same code a live call runs. It plays one scripted caller per call:

1. the voice starts greeting (a response in progress);
2. meanwhile the caller speaks ``utterance`` — as partials, then the finished sentence (``heard``);
3. the voice asks the agent (``ask_agent`` with the utterance) and the answer comes back while the
   greeting is still being spoken — the client must hold its ``response.create`` until it is done;
4. the greeting finishes (``said``), the voice says the answer (``said``) and the caller hangs up.

What the client sent is kept (``requests``, ``socket_frames``) for a test to read.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

GREETING = "Hello, how can I help?"
SDP_ANSWER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=fake-answer\r\n"


class FakeRealtime:
    def __init__(self, *, utterance: str = "What is on my plate today?"):
        self.utterance = utterance
        self.requests: list[tuple[str, str]] = []
        self.socket_frames: list[dict] = []
        self.answers: list[str] = []
        #: Whether the client asked the voice to speak the answer while the greeting was still going —
        #: which a real provider refuses (``conversation_already_has_active_response``).
        self.asked_to_speak_early = False
        #: Each ``accept``'s session, as posted — the instructions the voice was given.
        self.accepted: list[dict] = []
        self._calls = 0
        self._runner: Any = None
        self.base_url = ""

    async def __aenter__(self) -> "FakeRealtime":
        from aiohttp import web  # noqa: PLC0415

        app = web.Application()
        app.router.add_post("/v1/realtime/calls", self._create)
        app.router.add_post("/v1/realtime/calls/{call_id}/{verb}", self._verb)
        app.router.add_get("/v1/realtime", self._socket)
        app.router.add_post("/v1/audio/transcriptions", self._transcribe)
        app.router.add_post("/v1/audio/speech", self._speech)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]  # noqa: SLF001 — the only way to read an ephemeral port
        self.base_url = f"http://127.0.0.1:{port}/v1"
        return self

    async def __aexit__(self, *exc) -> None:
        if self._runner is not None:
            await self._runner.cleanup()

    def verbs(self) -> list[str]:
        """The call-control verbs the client used, in order (``create``, ``accept``, ``hangup`` …)."""
        return [verb for verb, _ in self.requests]

    # ── HTTP ────────────────────────────────────────────────────────────────
    async def _create(self, request):
        from aiohttp import web  # noqa: PLC0415

        form = await request.post()
        self._calls += 1
        call_id = f"rtc_fake{self._calls}"
        self.requests.append(("create", str(form.get("sdp") or "")))
        return web.Response(text=SDP_ANSWER, content_type="application/sdp",
                            headers={"Location": f"/v1/realtime/calls/{call_id}"})

    async def _verb(self, request):
        from aiohttp import web  # noqa: PLC0415

        verb = request.match_info["verb"]
        self.requests.append((verb, request.match_info["call_id"]))
        if verb == "accept":
            self.accepted.append(await request.json())
        return web.json_response({})

    async def _transcribe(self, request):
        from aiohttp import web  # noqa: PLC0415

        await request.read()
        self.requests.append(("transcribe", ""))
        return web.Response(text=self.utterance, content_type="text/plain")

    async def _speech(self, request):
        from aiohttp import web  # noqa: PLC0415

        body = await request.json()
        self.requests.append(("speech", str(body.get("input") or "")))
        return web.Response(body=b"ID3" + str(body.get("input") or "").encode(), content_type="audio/mpeg")

    # ── the sideband ────────────────────────────────────────────────────────
    async def _socket(self, request):
        from aiohttp import WSMsgType, web  # noqa: PLC0415

        ws = web.WebSocketResponse()
        await ws.prepare(request)
        call_id = request.query.get("call_id", "")
        self.requests.append(("sideband", call_id))
        answered: "asyncio.Future[str]" = asyncio.get_running_loop().create_future()

        async def read() -> None:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                frame = json.loads(msg.data)
                self.socket_frames.append(frame)
                item = frame.get("item") or {}
                if frame.get("type") == "conversation.item.create" and item.get("type") == "function_call_output":
                    if not answered.done():
                        answered.set_result(str(item.get("output") or ""))

        reader = asyncio.get_running_loop().create_task(read())
        try:
            # The greeting is a response, and it is still being spoken when the caller's question and
            # the voice's request to the agent arrive: an answer must wait for it to finish.
            await ws.send_json({"type": "response.created", "event_id": "e", "response": {"id": "r_greet"}})
            words = self.utterance.split(" ")
            half = max(1, len(words) // 2)
            for delta in (" ".join(words[:half]), " " + " ".join(words[half:])):
                await ws.send_json({"type": "conversation.item.input_audio_transcription.delta", "event_id": "e",
                                    "item_id": "u1", "content_index": 0, "delta": delta})
            await ws.send_json({"type": "conversation.item.input_audio_transcription.completed", "event_id": "e",
                                "item_id": "u1", "content_index": 0, "transcript": self.utterance})
            await ws.send_json({"type": "response.function_call_arguments.done", "event_id": "e", "response_id": "r1",
                                "item_id": "fc_item", "output_index": 0, "call_id": "fc1", "name": "ask_agent",
                                "arguments": json.dumps({"request": self.utterance})})
            answer = await answered
            self.answers.append(answer)
            self.asked_to_speak_early = self._responses_asked() > 0
            await ws.send_json(_said("greet", GREETING))
            await ws.send_json({"type": "response.done", "event_id": "e", "response": {"id": "r_greet"}})
            await self._next_response()
            await ws.send_json({"type": "response.created", "event_id": "e", "response": {"id": "r_answer"}})
            await ws.send_json(_said("a1", answer))
            await ws.send_json({"type": "response.done", "event_id": "e", "response": {"id": "r_answer"}})
        finally:
            await ws.close()
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        return ws


    def _responses_asked(self) -> int:
        """``response.create`` frames the client sent after its greeting request."""
        return max(0, sum(1 for f in self.socket_frames if f.get("type") == "response.create") - 1)

    async def _next_response(self) -> None:
        """Wait (briefly — it is already in flight or it is a bug) for the client's next response.create."""
        for _ in range(200):
            if self._responses_asked() > 0:
                return
            await asyncio.sleep(0.005)
        raise AssertionError("the client never asked the voice to speak the answer")


def _said(item_id: str, transcript: str) -> dict:
    return {"type": "response.output_audio_transcript.done", "event_id": "e", "response_id": "r", "item_id": item_id,
            "output_index": 0, "content_index": 0, "transcript": transcript}


def sign(body: bytes, secret: str, *, webhook_id: str = "wh_1", timestamp: Optional[int] = None) -> dict[str, str]:
    """Standard Webhooks headers for ``body`` under ``secret`` (``whsec_<base64>``) — what OpenAI sends."""
    import base64  # noqa: PLC0415
    import hashlib  # noqa: PLC0415
    import hmac  # noqa: PLC0415
    import time  # noqa: PLC0415

    ts = str(timestamp or int(time.time()))
    key = base64.b64decode(secret.removeprefix("whsec_"))
    mac = hmac.new(key, f"{webhook_id}.{ts}.".encode() + body, hashlib.sha256).digest()
    return {"webhook-id": webhook_id, "webhook-timestamp": ts, "webhook-signature": "v1," + base64.b64encode(mac).decode()}


def incoming_call(call_id: str, *, caller: str, dialled: str, number_header: str = "") -> dict:
    """A ``realtime.call.incoming`` webhook body, as OpenAI posts it for a SIP call."""
    headers = [{"name": "From", "value": f"sip:{caller}@pstn.twilio.com"},
               {"name": "To", "value": f"sip:{dialled}@sip.api.openai.com"},
               {"name": "Call-ID", "value": f"sip-{call_id}"}]
    if number_header:
        headers.append({"name": "X-Flow-Number", "value": number_header})
    return {"object": "event", "id": f"evt_{call_id}", "type": "realtime.call.incoming", "created_at": 1750287018,
            "data": {"call_id": call_id, "sip_headers": headers}}


__all__ = ["GREETING", "SDP_ANSWER", "FakeRealtime", "incoming_call", "sign"]
