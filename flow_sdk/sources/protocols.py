"""Capabilities, discovered — never declared. A source has a capability exactly when
``isinstance(source, Protocol)`` says so, on every altitude: the class in-process, a
proxy over a host, a client over REST. The five contract protocols come first; the rest are
what the Flowpad runtime asks a source beyond the contract."""

from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from typing import Any, AsyncIterator, Mapping, Optional, Protocol, runtime_checkable

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.sources.values.call import CallEvent, IncomingCall
from flow_sdk.sources.values.items import FileItem, MessageData, MessageItem, SourceItemSpec, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import DataPage


@runtime_checkable
class Readable(Protocol):
    async def get(self, origin: CloudOrigin) -> Optional[SourceItemSpec]: ...


@runtime_checkable
class Listable(Protocol):
    """One stream: the source's own ``query()``, paged by an opaque cursor. ``narrow`` updates fields of
    that query for one read (``since``, ``prefix``) and never replaces it."""

    async def fetch(
        self, cursor: Optional[str] = None, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> DataPage: ...

    def iterate(
        self, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> AsyncIterator[SourceItemSpec]: ...


@runtime_checkable
class Mutable(Protocol):
    async def create(self, data: DataSpec) -> SourceItemSpec: ...
    async def update(self, origin: CloudOrigin, changes: dict[str, Any]) -> SourceItemSpec: ...
    async def delete(self, origin: CloudOrigin) -> None: ...


@runtime_checkable
class ByteStore(Protocol):
    def open(self, file: FileItem, *, chunk_size: int = ...) -> AbstractAsyncContextManager[AsyncIterator[bytes]]: ...
    async def write(self, path: str, content: AsyncIterator[bytes]) -> FileItem: ...
    async def delete(self, origin: CloudOrigin) -> None: ...


@runtime_checkable
class Messaging(Protocol):
    async def send(self, data: MessageData) -> MessageItem: ...
    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem: ...


@runtime_checkable
class Drafting(Protocol):
    """Compose without sending: a draft is a resource with its own origin, never a send state."""

    async def draft(self, data: MessageData) -> MessageItem: ...


# ── beyond the contract: what the sync runtime asks ────────────────────────────


@runtime_checkable
class Verifiable(Protocol):
    """A source with a setup step a person completes (invite the bot, grant a scope)."""

    async def verify(self) -> "Verdict": ...


@runtime_checkable
class Choosing(Protocol):
    """A source that can list the remote containers a credential can see, for one config field."""

    async def choices(self, field: str) -> list[dict]: ...


@runtime_checkable
class Identified(Protocol):
    """A source that can say who it reads and posts as — every identity, primary first (a Slack
    bot answers to its user id and its bot id)."""

    async def whoami(self) -> tuple[UserProfile, ...]: ...


@runtime_checkable
class StableHandle(Protocol):
    """A source whose resources have an identity that survives a rename (an inode, a file id)."""

    def handle_of(self, item: SourceItemSpec) -> str: ...


@runtime_checkable
class CallSession(Protocol):
    """One call on the line. The provider carries the audio; this is the call's control channel —
    what was said, what the voice asks the agent, and the few things we can tell the call to do."""

    def events(self) -> AsyncIterator[CallEvent]: ...
    async def resolve(self, ask_id: str, answer: str) -> None: ...
    async def say(self, text: str) -> None: ...
    async def hangup(self) -> None: ...


@runtime_checkable
class Calling(Protocol):
    """A source people talk to live. A call reaches it by the provider's webhook
    (``calls_from_webhook``) or is started from our side (``start_call``: a browser's offer, a sound
    file, a number to dial); either way the runtime ``accept``s it and holds the ``CallSession``.

    ``start_call`` answers the starter (an SDP answer, a call id) and the call when it is on the line
    now — or ``None`` when the provider will ring back through the webhook (a dialled phone)."""

    async def start_call(self, offer: Mapping[str, Any]) -> "tuple[dict, Optional[IncomingCall]]": ...
    async def accept(self, call: IncomingCall, *, instructions: str) -> CallSession: ...
    async def reject(self, call: IncomingCall) -> None: ...


class Verdict(DataSpec):
    """Whether setup is complete, and what is missing if not. ``pending`` names the units
    still waiting on a person — the granularity a person acts at."""

    spec_kind = "source.verdict"

    ready: bool
    detail: str = ""
    pending: tuple[str, ...] = ()


#: The contract capabilities, by the name a boundary reports them under.
CAPABILITIES: dict[str, type] = {
    "readable": Readable,
    "listable": Listable,
    "mutable": Mutable,
    "byte_store": ByteStore,
    "messaging": Messaging,
    "drafting": Drafting,
    "verifiable": Verifiable,
    "choosing": Choosing,
    "identified": Identified,
    "stable_handle": StableHandle,
    "calling": Calling,
}


def capabilities_of(source: object) -> tuple[str, ...]:
    """The capability names ``source`` satisfies, in table order."""
    return tuple(name for name, proto in CAPABILITIES.items() if isinstance(source, proto))


__all__ = [
    "CAPABILITIES",
    "CallSession",
    "Calling",
    "ByteStore",
    "Choosing",
    "Drafting",
    "Identified",
    "Listable",
    "Messaging",
    "Mutable",
    "Readable",
    "StableHandle",
    "Verdict",
    "Verifiable",
    "capabilities_of",
]
