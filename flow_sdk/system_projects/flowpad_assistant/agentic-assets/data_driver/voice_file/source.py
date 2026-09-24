"""``VoiceFileSource`` — a recording in, a spoken answer out, as sound files.

**A clip is a call.** It has no line and no provider holding the audio, but it is the same thing
to the rest of the system: a caller, a sentence heard, a request the agent answers, a sentence said.
So a clip goes through the same runtime as a phone call (``agent_calls.answer_call``): transcribed
(``heard``), handed to the agent (``delegate``), and the answer spoken into a clip under ``out/``
(``said``). Both clips ride on their sentences as attachments.

A clip arrives by ``start_call``: a path on this machine (``{"path": …}``), or the bytes themselves
(``{"audio_b64": …, "name": …}``) from the UI, kept under ``in/``.
"""
from __future__ import annotations

import asyncio
import base64
import mimetypes
import secrets
from pathlib import Path
from typing import Any, ClassVar, Optional

from flow_sdk.external_apis.voice import speech
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.values.call import CallEvent, IncomingCall
from flow_sdk.sources.values.items import FileData, MessageItem
from flow_sdk.sources.voice import VoiceChannel

DEFAULT_FOLDER = "~/Flowpad voice"
#: The answer's format: small, and every browser plays it.
REPLY_SUFFIX = ".mp3"


class VoiceFileConfig(SourceConfig):
    """Where the clips live. Its key is the credential's, never here."""

    folder: str = DEFAULT_FOLDER
    voice: str = ""
    #: OpenAI's API root. Empty means OpenAI's own; a test names a loopback double.
    base_url: str = ""


class VoiceFileSource(VoiceChannel):

    Config = VoiceFileConfig
    provider = "voice_file"
    identity_config_key: ClassVar[str] = "folder"
    #: The clips are this machine's own: there is no stranger to keep out.
    open_inbound: ClassVar[bool] = True

    @property
    def root(self) -> Path:
        return Path(str(self.config.get("folder") or DEFAULT_FOLDER)).expanduser()

    def _voice(self) -> str:
        return str(self.config.get("voice") or "").strip() or speech.SPEECH_VOICE

    async def start_call(self, offer: Any) -> "tuple[dict, Optional[IncomingCall]]":
        offer = dict(offer or {})
        clip = self._clip_of(offer)
        call_id = f"clip_{secrets.token_hex(6)}"
        caller = str(offer.get("caller") or "").strip() or "sound-file"
        self._pending[call_id] = clip
        return {"clip": str(clip)}, IncomingCall(call_id=call_id, caller=caller, dialed=self.account, caller_name=caller)

    #: Clips handed in and not yet answered, by call id (the same process answers them).
    _pending: ClassVar[dict[str, Path]] = {}

    def _clip_of(self, offer: dict) -> Path:
        if offer.get("audio_b64"):
            name = Path(str(offer.get("name") or "clip.wav")).name
            target = self.root / "in" / f"{secrets.token_hex(4)}-{name}"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(str(offer["audio_b64"])))
            return target
        path = Path(str(offer.get("path") or "")).expanduser()
        if not str(offer.get("path") or "").strip() or not path.is_file():
            raise ValueError("a sound-file call needs a clip: {path} on this machine, or {audio_b64, name}")
        return path

    async def accept(self, call: IncomingCall, *, instructions: str):
        clip = self._pending.pop(call.call_id, None)
        if clip is None:
            raise ValueError(f"no clip was handed in for {call.call_id}")
        return ClipCall(self.client(), clip, self.root / "out", voice=self._voice())

    async def say_to(self, person: str, text: str) -> MessageItem:
        """A spoken clip for the person, under ``out/`` — a voice note nobody has to be on a call for."""
        client = self.client()
        out = await speech.speak(client, text, self.root / "out" / f"{_safe(person)}-{secrets.token_hex(4)}{REPLY_SUFFIX}",
                                 voice=self._voice())
        item = self.said(person, text, f"note-{out.stem}")
        return item


class ClipCall:
    """One clip held as a call: heard → the agent → said, then the line closes."""

    def __init__(self, client, clip: Path, out_dir: Path, *, voice: str):
        self.client, self.clip, self.out_dir, self.voice = client, clip, out_dir, voice
        self._answer: "asyncio.Future[str]" = asyncio.get_running_loop().create_future()

    async def events(self):
        heard = await speech.transcribe(self.client, self.clip)
        yield CallEvent(kind="heard", text=heard or "(no words in the recording)", item_id="heard", audio=_file(self.clip))
        if heard:
            yield CallEvent(kind="delegate", text=heard, ask_id="clip")
            answer = await self._answer
            out = await speech.speak(self.client, answer, self.out_dir / f"{self.clip.stem}-reply{REPLY_SUFFIX}", voice=self.voice)
            yield CallEvent(kind="said", text=answer, item_id="said", audio=_file(out))
        yield CallEvent(kind="ended")

    async def resolve(self, ask_id: str, answer: str) -> None:
        if not self._answer.done():
            self._answer.set_result(answer)

    async def say(self, text: str) -> None:
        await self.resolve("clip", text)

    async def hangup(self) -> None:
        if not self._answer.done():
            self._answer.cancel()


def _file(path: Path) -> FileData:
    return FileData(name=path.name, path=str(path), media_type=mimetypes.guess_type(path.name)[0] or "audio/mpeg",
                    size=path.stat().st_size if path.exists() else None)


def _safe(person: str) -> str:
    return "".join(c if c.isalnum() or c in "-_+" else "_" for c in person)[:40] or "someone"
