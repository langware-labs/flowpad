"""``flow_sdk.sources`` — the access contract every data source implements.

A source is an async session (``async with source:``) offering, by capability, ``get`` /
``fetch`` / ``iterate``, ``open`` / ``write`` / ``delete``, ``create`` / ``update``,
``send`` / ``reply`` / ``draft``, and always ``on_change`` / ``notify``. Values are frozen
``DataSpec``s; capabilities are protocols discovered by ``isinstance``; failures are the
``SourceError`` family. This package imports ``flow_sdk.schema`` and the standard library
only — the sync runtime (``flow_sdk.ingest``), the inbox and the pipes are applications
built on it, never dependencies of it. See ``docs/data-management/source-contract-boundary.md``.
"""

from flow_sdk.sources.base import Altitude, CollectionSource, Source
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, Credentials
from flow_sdk.sources.errors import (
    AccessDenied,
    InvalidCursor,
    NotFound,
    OutcomeUnknown,
    Rejected,
    SourceError,
    SourceUnavailable,
    Unsupported,
)
from flow_sdk.sources.folder import FolderSource
from flow_sdk.sources.memory import MemoryMessages, MemorySource, MemoryStore
from flow_sdk.sources.protocols import (
    ByteStore,
    Choosing,
    Drafting,
    Identified,
    Listable,
    Messaging,
    Mutable,
    Readable,
    Segmented,
    StableHandle,
    Verdict,
    Verifiable,
    capabilities_of,
)
from flow_sdk.sources.values import (
    DEFAULT_PAGE_SIZE,
    ChangeHandler,
    ChangePage,
    CloudOrigin,
    DataPage,
    DataQuery,
    DataSourceEvent,
    EmailMessageData,
    EventKind,
    FeedItemData,
    FileData,
    FileDataPage,
    FileItem,
    MessageData,
    MessageItem,
    MessageQuery,
    Move,
    ObjectQuery,
    Payload,
    RecordQuery,
    SegmentRef,
    SourceItemSpec,
    UserProfile,
)

__all__ = [
    "DEFAULT_PAGE_SIZE",
    "AccessDenied",
    "Altitude",
    "AuthShape",
    "ByteStore",
    "ChangeHandler",
    "ChangePage",
    "Choosing",
    "CloudOrigin",
    "CollectionSource",
    "Credentials",
    "DataPage",
    "DataQuery",
    "DataSourceEvent",
    "Drafting",
    "EmailMessageData",
    "FeedItemData",
    "EventKind",
    "FileData",
    "FileDataPage",
    "FileItem",
    "FolderSource",
    "Identified",
    "InvalidCursor",
    "Listable",
    "MemoryMessages",
    "MemorySource",
    "MemoryStore",
    "MessageData",
    "MessageItem",
    "MessageQuery",
    "Messaging",
    "Move",
    "Mutable",
    "NotFound",
    "ObjectQuery",
    "OutcomeUnknown",
    "Payload",
    "Readable",
    "RecordQuery",
    "Rejected",
    "SegmentRef",
    "Segmented",
    "Source",
    "SourceBinding",
    "SourceError",
    "SourceItemSpec",
    "SourceUnavailable",
    "StableHandle",
    "Unsupported",
    "UserProfile",
    "Verdict",
    "Verifiable",
    "capabilities_of",
]
