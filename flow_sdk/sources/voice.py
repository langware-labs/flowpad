"""``VoiceChannel`` — what every voice source is, whatever carries its audio.

Three drivers ship on it — a phone line, a browser's microphone and speakers, a sound file — and
each owns only its transport: how a call starts (``start_call``) and how it is held (``accept``).
Everything the rest of the system reads is the same on all three, which is the point: a call on
any of them is the channel ``voice``, a thread per person, one message per sentence
(``VoiceTurnData``), and the agent answering as itself.

* **Channel.** ``origin_kind = "voice"`` for every voice driver, the way two WhatsApp transports
  share ``whatsapp`` — a person's calls read as one kind of conversation whichever way they came in.
* **Addressing.** A call IS the thread: ``<account>/calls`` scopes it and ``<person>/<call>`` keys
  it (``IncomingCall.conversation_key``: the dial's token for a call we placed — so the note the dial
  leaves and the call are one conversation — else the call's id). A voice message outside any call is
  the person's own thread, keyed by their address.
  A sentence lives in ``<account>/calls/<person>``. Replies quote nothing — speech has no quote.
* **The key.** Calls run on ``OPENAI_API_KEY`` from the source's credential (``auth.env``: the
  project's store, then the process environment), else the key this machine stored for OpenAI.
"""

from __future__ import annotations

import os
from typing import Any, ClassVar, Optional

from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.values.call import IncomingCall
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin

#: The channel every voice driver stamps.
VOICE = "voice"
CALLS = "calls"
PEOPLE = "people"


def thread_origin(kind: str, account: str, person: str, call_id: str = "") -> CloudOrigin:
    """A thread on a voice source: one call, ``(voice, <account>/calls, <person>/<call id>)`` — or,
    with no call, the person's own, ``(voice, <account>/calls, <person>)``."""
    return CloudOrigin(kind=kind, namespace=f"{account}/{CALLS}", key=f"{person}/{call_id}" if call_id else person)


def sentence_origin(kind: str, account: str, person: str, key: str) -> CloudOrigin:
    """One sentence, inside the person's scope — so a reply is routed from the sentence alone."""
    return CloudOrigin(kind=kind, namespace=f"{account}/{CALLS}/{person}", key=key)


def person_profile(kind: str, account: str, address: str, name: str = "") -> UserProfile:
    return UserProfile(origin=CloudOrigin(kind=kind, namespace=f"{account}/{PEOPLE}", key=address),
                       name=name or None, address=address)


class VoiceChannel(MessageSource):
    """The shared half of a voice source. A driver subclasses it and adds its transport."""

    origin_kind: ClassVar[str] = VOICE
    #: What ``send`` returns is the only copy of it: speech is not echoed back as a record.
    echoes_sends: ClassVar[bool] = False

    @classmethod
    def outbound_spec(cls) -> type:
        from flow_sdk.builtin.source_item import VoiceMessageSpec  # noqa: PLC0415

        return VoiceMessageSpec

    # ── who we are here ─────────────────────────────────────────────────────
    @property
    def account(self) -> str:
        """The address this source answers at — its identity config value."""
        return str(self.config.get(type(self).identity_config_key) or self.binding.account_key or "").strip()

    def thread(self, person: str) -> CloudOrigin:
        return thread_origin(self._scope.kind, self.account, person)

    def ours(self) -> UserProfile:
        return person_profile(self._scope.kind, self.account, self.account, self.binding.persona.name if self.binding.persona else "")

    async def whoami(self) -> tuple[UserProfile, ...]:
        return (self.ours(),)

    # ── the OpenAI key a call runs on ───────────────────────────────────────
    def api_key(self) -> str:
        key = self.secret("OPENAI_API_KEY")
        if not key:
            try:
                from flow_sdk.lm_api import get_lm_api  # noqa: PLC0415

                key = get_lm_api("openai") or ""
            except Exception:  # noqa: BLE001 — a store that cannot be read has no key
                key = ""
        if not key:
            from flow_sdk.sources.errors import AccessDenied  # noqa: PLC0415

            raise AccessDenied("no OpenAI key for voice — set OPENAI_API_KEY or store one with `flow llm`")
        return key

    def secret(self, name: str) -> str:
        """A credential value by its variable name (the manifest's ``auth.env``), else the process environment."""
        stored = self.credentials.values.get(name) if self.credentials is not None else None
        value = stored.get_secret_value() if stored is not None else ""
        return value.strip() or os.environ.get(name, "").strip()

    def client(self):
        """The one OpenAI client this source holds a call with — closed when its session closes."""
        if getattr(self, "_voice_client", None) is None:
            from flow_sdk.external_apis.voice.realtime import client_for  # noqa: PLC0415

            self._voice_client = client_for(self.api_key(), base_url=str(self.config.get("base_url") or "").strip())
        return self._voice_client

    async def _close(self) -> None:
        client, self._voice_client = getattr(self, "_voice_client", None), None
        if client is not None:
            await client.close()

    # ── send: said TO a person ──────────────────────────────────────────────
    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        """A voice send is to a person — their address is the thread. Nothing is quoted."""
        person = str(to or thread_key or "").strip()
        if not person:
            raise ValueError("a voice send needs the person it is said to")
        return MessageData(text=text, conversation=self.thread(person)), None

    async def send(self, data: MessageData) -> MessageItem:
        person = self._person_of(data)
        return await self.say_to(person, data.text or "")

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        base = f"{self.account}/{CALLS}/"
        person = origin.namespace[len(base):] if origin.namespace.startswith(base) else ""
        if not person:
            raise ValueError(f"{origin!r} is not a sentence on this voice source")
        return await self.say_to(person, data.text or "")

    async def say_to(self, person: str, text: str) -> MessageItem:
        """Deliver ``text`` to ``person`` the way this transport can (dial them, speak it, write a clip)."""
        from flow_sdk.sources.errors import Unsupported  # noqa: PLC0415

        raise Unsupported(f"{type(self).__name__} cannot say anything outside a call")

    def said(self, person: str, text: str, key: str, *, call: str = "", **extra: Any) -> MessageItem:
        """What we said to ``person`` — in the call ``call`` (its conversation key) when there is one —
        as the item ``send`` answers with. Addressed to them, so the conversation knows who it is with."""
        from datetime import datetime, timezone  # noqa: PLC0415

        from flow_sdk.sources.values.call import VoiceTurnData  # noqa: PLC0415

        extra.setdefault("sent_at", datetime.now(timezone.utc))
        return MessageItem(
            origin=sentence_origin(self._scope.kind, self.account, person, key),
            data=VoiceTurnData(
                text=text, conversation=thread_origin(self._scope.kind, self.account, person, call), sender=self.ours(),
                recipients=(person_profile(self._scope.kind, self.account, person),), **extra,
            ),
        )

    def _person_of(self, data: MessageData) -> str:
        if data.conversation is not None:
            return data.conversation.key
        if len(data.recipients) == 1:
            return data.recipients[0].address or data.recipients[0].origin.key
        raise ValueError("a voice send is said to exactly one person")

    # ── calls: every voice driver has them ──────────────────────────────────
    async def start_call(self, offer: Any) -> "tuple[dict, Optional[IncomingCall]]":
        raise NotImplementedError

    async def accept(self, call: IncomingCall, *, instructions: str):
        raise NotImplementedError

    async def reject(self, call: IncomingCall) -> None:
        return None


__all__ = ["CALLS", "VOICE", "VoiceChannel", "person_profile", "sentence_origin", "thread_origin"]
