"""Capabilities, discovered — never declared. A source has a capability exactly when
``isinstance(source, Protocol)`` says so, on every altitude: the class in-process, a
proxy over a host, a client over REST. The five contract protocols come first; the rest are
what the Flowpad runtime asks a source beyond the contract."""

from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from typing import Any, AsyncIterator, Optional, Protocol, runtime_checkable

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.sources.values.items import FileItem, MessageData, MessageItem, SourceItemSpec, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import DataPage
from flow_sdk.sources.values.query import DataQuery
from flow_sdk.sources.values.segment import SegmentRef


@runtime_checkable
class Readable(Protocol):
    async def get(self, origin: CloudOrigin) -> Optional[SourceItemSpec]: ...


@runtime_checkable
class Listable(Protocol):
    async def fetch(
        self, query: Optional[DataQuery] = None, *, cursor: Optional[str] = None, page_size: Optional[int] = None
    ) -> DataPage: ...

    def iterate(self, query: Optional[DataQuery] = None, *, page_size: Optional[int] = None) -> AsyncIterator[SourceItemSpec]: ...


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
class Segmented(Protocol):
    """A source whose default selection splits into independently-cursored units."""

    async def segments(self) -> list[SegmentRef]: ...


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
    """A source that can say who it reads and posts as."""

    async def whoami(self) -> UserProfile: ...


@runtime_checkable
class StableHandle(Protocol):
    """A source whose resources have an identity that survives a rename (an inode, a file id)."""

    def handle_of(self, item: SourceItemSpec) -> str: ...


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
    "segmented": Segmented,
    "verifiable": Verifiable,
    "choosing": Choosing,
    "identified": Identified,
    "stable_handle": StableHandle,
}


def capabilities_of(source: object) -> tuple[str, ...]:
    """The capability names ``source`` satisfies, in table order."""
    return tuple(name for name, proto in CAPABILITIES.items() if isinstance(source, proto))


__all__ = [
    "CAPABILITIES",
    "ByteStore",
    "Choosing",
    "Drafting",
    "Identified",
    "Listable",
    "Messaging",
    "Mutable",
    "Readable",
    "Segmented",
    "StableHandle",
    "Verdict",
    "Verifiable",
    "capabilities_of",
]
