"""``VoiceBrowserSource`` — a voice line the browser calls: its microphone in, the agent's voice out.

**The browser never holds a key.** It posts its WebRTC offer to this instance
(``POST /api/v1/data_source/<id>/call``, ``{"offer": {"sdp": …}}``); the server creates the call
on OpenAI Realtime with the real key and hands back the SDP answer. Audio then flows straight
between the browser and OpenAI — never through this process. What this process holds is the call's
control channel (the sideband), where the sentences and the agent's delegations arrive.

The caller is whoever is at the browser — our own UI, behind the app's own auth — so the line is
open (``open_inbound``): there is no stranger to keep out.
"""
from __future__ import annotations

import secrets
from typing import Any, ClassVar, Optional

from flow_sdk.external_apis.voice import realtime
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.values.call import IncomingCall
from flow_sdk.sources.values.items import MessageItem
from flow_sdk.sources.voice import VoiceChannel

GREETING = "Greet the caller in one short sentence and ask how you can help."


class VoiceBrowserConfig(SourceConfig):
    """What a browser voice line is configured with. Its key is the credential's, never here."""

    room: str = "desk"
    voice: str = ""
    model: str = ""
    #: OpenAI's API root. Empty means OpenAI's own; a test names a loopback double.
    base_url: str = ""


class VoiceBrowserSource(VoiceChannel):

    Config = VoiceBrowserConfig
    provider = "voice_browser"
    identity_config_key: ClassVar[str] = "room"
    open_inbound: ClassVar[bool] = True
    #: A line with nobody on it cannot be spoken into: a send then is a draft, kept for when they call.
    sends_may_draft: ClassVar[bool] = True

    def _model(self) -> str:
        return str(self.config.get("model") or "").strip() or realtime.DEFAULT_MODEL

    def _voice(self) -> str:
        return str(self.config.get("voice") or "").strip() or realtime.DEFAULT_VOICE

    async def start_call(self, offer: Any) -> "tuple[dict, Optional[IncomingCall]]":
        """A browser's SDP offer → the call, created server side. ``offer.caller`` names who is calling."""
        sdp = str((offer or {}).get("sdp") or "")
        if not sdp.strip():
            raise ValueError("a browser call needs the browser's SDP offer")
        answer, call_id = await realtime.create_browser_call(
            self.client(), sdp=sdp, instructions="Wait for your instructions.", model=self._model(), voice=self._voice()
        )
        caller = str((offer or {}).get("caller") or "").strip() or f"browser-{secrets.token_hex(3)}"
        call = IncomingCall(call_id=call_id, caller=caller, dialed=self.account,
                            caller_name=str((offer or {}).get("caller_name") or "").strip())
        return {"sdp": answer}, call

    async def accept(self, call: IncomingCall, *, instructions: str):
        """The call already exists (the browser is connected); give it the agent's session over the sideband."""
        client = self.client()
        session = realtime.RealtimeCallSession(
            client, call.call_id, greet=GREETING,
            update=realtime.session_config(instructions=instructions, model=self._model(), voice=self._voice()),
        )
        return self.hold(call, session)

    async def reject(self, call: IncomingCall) -> None:
        await realtime.RealtimeCallSession(self.client(), call.call_id).hangup()

    async def say_to(self, person: str, text: str) -> MessageItem:
        """Said into the person's live call. A browser line reaches nobody who is not on it, so with no
        call the message is a draft (no ``sent_at``) — the outcome says so rather than pretending."""
        said = await self.say_live(person, text)
        return said if said is not None else self.said(person, text, f"draft-{secrets.token_hex(6)}", sent_at=None)
