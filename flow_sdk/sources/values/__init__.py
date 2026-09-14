"""The values every source speaks: identity, items, queries, pages, events, segments."""

from flow_sdk.sources.values.event import ChangeHandler, DataSourceEvent, EventKind
from flow_sdk.sources.values.items import (
    EmailMessageData,
    FileData,
    FileItem,
    MessageData,
    MessageItem,
    Payload,
    SourceItemSpec,
    UserProfile,
)
from flow_sdk.sources.values.origin import LEGACY_NAMESPACE, CloudOrigin
from flow_sdk.sources.values.page import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ChangePage, DataPage, FileDataPage, Move
from flow_sdk.sources.values.query import DataQuery, MessageQuery, ObjectQuery, RecordQuery
from flow_sdk.sources.values.segment import SegmentRef

__all__ = [
    "DEFAULT_PAGE_SIZE",
    "LEGACY_NAMESPACE",
    "MAX_PAGE_SIZE",
    "ChangeHandler",
    "ChangePage",
    "CloudOrigin",
    "DataPage",
    "DataQuery",
    "DataSourceEvent",
    "EmailMessageData",
    "EventKind",
    "FileData",
    "FileDataPage",
    "FileItem",
    "MessageData",
    "MessageItem",
    "MessageQuery",
    "Move",
    "ObjectQuery",
    "Payload",
    "RecordQuery",
    "SegmentRef",
    "SourceItemSpec",
    "UserProfile",
]
