"""``ScriptedSource`` — a message source that answers what a test tells it to.

Registered under any provider name, so a snippet written for ``agentmail`` or ``slack`` runs verbatim
with no network: a traversal hands out the next scripted page, and a send records what was sent
(the send path then records its copy, marked ours, as it does for every real sender). The controls live on the ``Script`` the context manager yields, because the
engine builds a fresh source instance for every session.
"""

from __future__ import annotations

import asyncio
from collections import deque
from contextlib import asynccontextmanager, contextmanager
from dataclasses import replace
from typing import AsyncGenerator, ClassVar, Iterable, Optional

from pydantic import PrivateAttr

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.driver_runtime import DRIVERS
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import NotFound, Rejected
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.files import FileSupport
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.items import (
    EmailMessageData,
    FileItem,
    FileKind,
    MessageData,
    MessageFileData,
    MessageItem,
    ReactionData,
    ReactionItem,
    ReactionMode,
)
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import DataPage
from flow_sdk.utils.serialization import iso_to_utc

#: The flat record kind a scripted message is stored under.
SCRIPTED_KIND = "message"


class Script:
    """What a test scripts and observes, shared by every session of one scripted provider."""

    def __init__(self, provider: str, pages: Iterable[list[dict]] = ()):
        self.provider = provider
        self.pages: deque[list[dict]] = deque(pages)
        self.sent: list[dict] = []
        #: Set on every send. NOT a safe place to stop a fence: a send happens INSIDE ``reply()``,
        #: before the ack, so cancelling here reproduces the crash window.
        self.sent_event = asyncio.Event()
        #: Set by the first traversal after a send — the loop has replied, acked, slept and come
        #: round again. The "done" signal for ``run_fence_until``.
        self.settled = asyncio.Event()
        self.fetches = 0
        #: Set by a test to stand in for the whole send (a draft, a failure); ``None`` sends normally.
        self.send = None
        self._sent_at_last_fetch = 0
        self._outgoing: dict = {}
        #: The bytes of every file an inbound message carried, by media key — what ``open`` serves.
        self.blobs: dict[str, bytes] = {}
        #: Every ``react``/``unreact``: ``(target key, emoji, removed)``.
        self.reacted: list[tuple[str, str, bool]] = []
        #: The emoji this channel shows (a stand-in for Telegram's list): anything else is ``Rejected``.
        self.allowed_emoji: frozenset[str] = frozenset({"👍", "👀", "✅", "❤️", "🔥", "🎉", "🙏"})
        #: False keeps the scripted records inside the stream inbox (projected into conversations).
        self.flat_kind = True

    def push(self, *messages: dict) -> None:
        """Queue one page of inbound messages for the next traversal."""
        self.pages.append(list(messages))


class ScriptedSource(MessageSource):
    provider = "scripted"
    files = FileSupport(
        kinds=frozenset(FileKind),
        per_message=1,
        max_bytes={FileKind.IMAGE: 5_000_000},
        caption_max=1024,
        caption_kinds=frozenset({FileKind.IMAGE, FileKind.VIDEO, FileKind.DOCUMENT}),
    )
    quotes = True
    reactions_per_actor = 1
    #: The script a registered subclass is built over — the engine builds a fresh source per session.
    script_of: ClassVar[Optional[Script]] = None

    def __init__(self, binding: SourceBinding, script: Optional[Script] = None) -> None:
        super().__init__(binding)
        self.script = script or type(self).script_of

    def message_for(self, *, thread_key, to, text, subject="", in_reply_to="", conversation_id=""):
        self.script._outgoing = {"thread_key": thread_key, "to": to, "subject": subject, "in_reply_to": in_reply_to}
        return EmailMessageData(text=text, subject=subject or None), None

    @classmethod
    def namespace_for(cls, binding: SourceBinding) -> str:
        return binding.account_key or binding.source_id or cls.provider

    async def verify(self) -> Verdict:
        return Verdict(ready=True)

    async def fetch(self, cursor: Optional[str] = None, *, page_size: Optional[int] = None, narrow=None) -> DataPage:
        self._require_open()
        script = self.script
        script.fetches += 1
        if len(script.sent) > script._sent_at_last_fetch:
            script._sent_at_last_fetch = len(script.sent)
            script.settled.set()
        if not script.pages:
            return DataPage(items=())
        return DataPage(items=tuple(self._item(m) for m in script.pages.popleft()))

    async def iterate(self, *, page_size: Optional[int] = None, narrow=None) -> AsyncGenerator[MessageItem, None]:
        for item in (await self.fetch()).items:
            yield item

    async def send(self, data: MessageData) -> MessageItem:
        return self._sent(data)

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        return self._sent(data, quoted=origin.key)

    @asynccontextmanager
    async def _stream(self, file: FileItem):
        blob = self.script.blobs.get(file.origin.key)
        if blob is None:
            raise NotFound("the file expired", origin=file.origin)

        async def chunks():
            yield blob

        yield chunks()

    def open(self, file: FileItem, *, chunk_size: int = 65536):
        return self._stream(file)

    async def react(self, target: CloudOrigin, emoji: str) -> None:
        if emoji not in self.script.allowed_emoji:
            raise Rejected(f"{emoji} is not a reaction this channel shows")
        self.script.reacted.append((target.key, emoji, False))

    async def unreact(self, target: CloudOrigin, emoji: str = "") -> None:
        self.script.reacted.append((target.key, emoji, True))

    def _sent(self, data: MessageData, quoted: str = "") -> MessageItem:
        external_id = f"<sent-{mint_uuid()}@{self.provider}>"
        files = [
            {"name": f.data.name, "as_": str(f.data.as_), "caption": f.data.caption, "path": f.data.path}
            for f in data.attachments
        ]
        self.script.sent.append(
            {"external_id": external_id, "text": data.text or "", "files": files, "quoted": quoted, **self.script._outgoing}
        )
        self.script.sent_event.set()
        return MessageItem(origin=self.origin(external_id), data=data)

    def _item(self, m: dict):
        if m.get("reaction"):
            r = m["reaction"]
            author = r.get("author", "someone@example.com")
            return ReactionItem(
                origin=self.origin(f"reaction-{mint_uuid()}"),
                data=ReactionData(
                    target=self.origin(r["target"]),
                    sender=UserProfile(origin=self.origin(author), address=author),
                    emojis=tuple(r.get("emojis", ())),
                    mode=ReactionMode(r.get("mode", "set")),
                ),
            )
        return self._message(m)

    def _message(self, m: dict) -> MessageItem:
        # Globally unique, as a provider's ids are: a per-instance counter collided across tests
        # sharing one source, and the "new" message became an update of an old one.
        external_id = m.get("external_id") or f"<{mint_uuid()}@{self.provider}>"
        author = m.get("author", "someone@example.com")
        reply = m.get("reply_to_external_id")
        fields = dict(
            text=m.get("body", ""),
            sender=UserProfile(origin=self.origin(author), address=author),
            conversation=self.origin(m.get("thread_key", "thr-1")),
            in_reply_to=self.origin(reply) if reply else None,
            sent_at=iso_to_utc(m["occurred_at"]) if m.get("occurred_at") else None,
            attachments=tuple(self._file(f) for f in m.get("files", ())),
        )
        # A plain message unless the script names a subject — the kind the scripted channel always had.
        data = EmailMessageData(subject=m["name"], **fields) if m.get("name") else MessageData(**fields)
        return MessageItem(origin=self.origin(external_id), data=data)


    def _file(self, f: dict) -> FileItem:
        key = f.get("key") or f"media-{mint_uuid()}"
        if "bytes" in f:
            self.script.blobs[key] = f["bytes"]
        data = MessageFileData(
            name=f.get("name"), media_type=f.get("media_type"), as_=FileKind(f.get("as_", "document")), caption=f.get("caption")
        )
        return FileItem(origin=self.origin(key), data=data)


class _ScriptedType(DataDriver):
    """The scripted provider's driver: a send the test replaced answers first."""

    _abstract: ClassVar[bool] = True  # a test double, not a second registered type
    _script: Optional[Script] = PrivateAttr(None)

    def __init__(self, cls, script: Script, *, kind: str):
        super().__init__(name=cls.provider, kind=kind)
        self._cls, self._script = cls, script

    @property
    def script(self) -> Script:
        return self._script

    async def traverse(self, row, position):
        """The scripted channel's records keep the flat kind the scripted driver always stamped
        (``message``), which sits outside the stream inbox's ``content.message`` root — a fence about paging
        or acks must not become a test of projecting one very long thread."""
        found = await super().traverse(row, position)
        if not found.items or not self.script.flat_kind:
            return found
        return replace(found, items=[item.model_copy(update={"kind": SCRIPTED_KIND}) for item in found.items])

    async def send(self, row, **kwargs):
        if self.script.send is not None:
            return await self.script.send(row, **kwargs)
        return await super().send(row, **kwargs)


@contextmanager
def scripted_provider(provider: str = "scripted", *, pages: Iterable[list[dict]] = (), projected: bool = False):
    """Register a scripted source under *provider* for the block, restoring what was there.
    ``projected`` keeps its records in the stream inbox's kind, so they thread into conversations."""
    previous: Optional[DataDriver] = DRIVERS.get_or_none(provider)
    script = Script(provider, pages)
    script.flat_kind = not projected
    cls = type(f"Scripted_{provider}", (ScriptedSource,), {"provider": provider, "script_of": script})
    DRIVERS.register(_ScriptedType(cls, script, kind=f"datasource.api.{provider}"))
    try:
        yield script
    finally:
        DRIVERS.unregister(provider)
        if previous is not None:
            DRIVERS.register(previous)


__all__ = ["SCRIPTED_KIND", "Script", "ScriptedSource", "scripted_provider"]
