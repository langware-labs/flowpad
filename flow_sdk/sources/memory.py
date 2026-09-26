"""In-memory sources — the authoritative test doubles.

``MemoryStore`` holds records of one payload schema and implements the read path;
``MemorySource`` adds create/update/delete; ``MemoryMessages`` adds send, reply and draft
over ``MessageData``, plus ``receive`` to stand in for a provider delivering a message.
Records outlive sessions, like a remote provider's, and are copied in and out so no caller
shares mutable state with the store. Each class exposes only its own capabilities.
"""

from __future__ import annotations

import itertools
import json
from datetime import datetime, timezone
from typing import Any, ClassVar, Iterable, Mapping, Optional

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.sources.base import Altitude, CollectionSource
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import NotFound, Unsupported
from flow_sdk.sources.families import MessageSource, RecordSource
from flow_sdk.sources.values.items import MessageData, MessageItem, SourceItemSpec, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.query import DataQuery, MessageQuery


class MemoryStore(RecordSource, CollectionSource):
    """Records of exactly one payload schema."""

    provider = "memory"
    altitude = Altitude.IN_PROCESS
    #: The payload schema; a subclass pins it, or the constructor takes it.
    schema: ClassVar[Optional[type[DataSpec]]] = None
    item_type: ClassVar[type[SourceItemSpec]] = SourceItemSpec

    @classmethod
    def origin_kind_for(cls, config: Mapping[str, Any]) -> str:
        return str(config.get("kind") or cls.origin_kind or cls.provider)

    @classmethod
    def namespace_for(cls, binding: SourceBinding) -> str:
        return str(binding.config.get("namespace") or "memory")

    @classmethod
    def of(cls, schema: Optional[type[DataSpec]] = None, *, namespace: str = "memory", kind: str = "memory", **binding: Any):
        return cls(SourceBinding(config={"namespace": namespace, "kind": kind}, **binding), schema=schema)

    def __init__(self, binding: SourceBinding, schema: Optional[type[DataSpec]] = None) -> None:
        super().__init__(binding)
        resolved = schema or type(self).schema
        if not (isinstance(resolved, type) and issubclass(resolved, DataSpec)):
            raise TypeError("a memory source needs a DataSpec payload schema")
        self.payload_schema: type[DataSpec] = resolved
        self._records: dict[str, DataSpec] = {}
        self._keys = itertools.count(1)

    async def _lookup(self, key: str) -> Optional[DataSpec]:
        return self._records.get(key)

    async def _scan(self, query: Optional[DataQuery]) -> list[tuple[str, DataSpec]]:
        return sorted((key, data) for key, data in self._records.items() if self._matches(query, data))

    def _matches(self, query: Optional[DataQuery], data: DataSpec) -> bool:
        return True

    def _item(self, key: str, data: DataSpec) -> SourceItemSpec:
        return self.item_type(origin=self._scope.origin(key), data=data.model_copy(deep=True))

    def _store(self, data: DataSpec, key: Optional[str] = None) -> SourceItemSpec:
        if type(data) is not self.payload_schema:
            raise TypeError(f"expected {self.payload_schema.__name__}, got {type(data).__name__}")
        key = key or f"{next(self._keys):08d}"
        self._records[key] = data.model_copy(deep=True)
        return self._item(key, data)


class MemorySource(MemoryStore):
    """Records supporting create, update and delete. No query predicates: pass no query."""

    def __init__(self, binding: SourceBinding, schema: Optional[type[DataSpec]] = None, *, read_only: Iterable[str] = ()) -> None:
        super().__init__(binding, schema)
        self.read_only = frozenset(read_only)

    async def create(self, data: DataSpec) -> SourceItemSpec:
        self._require_open()
        return self._store(data)

    async def update(self, origin: CloudOrigin, changes: dict[str, Any]) -> SourceItemSpec:
        self._require_open()
        key = self._scope.key(origin)
        if not isinstance(changes, dict):
            raise TypeError(f"changes must be a dict, got {type(changes).__name__}")
        if not changes:
            raise ValueError("an empty update specifies no change")
        fields = self.payload_schema.model_fields
        if unknown := changes.keys() - fields.keys():
            raise ValueError(f"unknown fields: {sorted(unknown)}")
        if blocked := changes.keys() & self.read_only:
            raise Unsupported(f"fields are not writable: {sorted(blocked)}", origin=origin)
        existing = self._records.get(key)
        if existing is None:
            raise NotFound("record does not exist", origin=origin)
        # Merge field values, not dumps: nested models keep their types; omitted fields keep
        # their stored values; whole-record validators run on the result.
        current = {name: getattr(existing, name) for name in fields}
        merged = self.payload_schema.model_validate(current | changes)
        return self._store(merged, key)

    async def delete(self, origin: CloudOrigin) -> None:
        self._require_open()
        self._records.pop(self._scope.key(origin), None)


class MemoryMessages(MessageSource, MemoryStore):
    """Conversations of ``MessageData`` supporting history, send, reply and draft."""

    schema = MessageData
    supported_queries = (MessageQuery,)
    item_type = MessageItem

    def __init__(self, binding: SourceBinding, schema: Optional[type[DataSpec]] = None, *, sender: Optional[UserProfile] = None) -> None:
        super().__init__(binding, schema)
        self.sender = sender
        self._conversations: set[CloudOrigin] = set()

    @classmethod
    def of(cls, schema=None, *, namespace: str = "chat", kind: str = "memory", sender: Optional[UserProfile] = None, **binding: Any):
        return cls(SourceBinding(config={"namespace": namespace, "kind": kind}, **binding), sender=sender)

    def _matches(self, query: Optional[MessageQuery], data: DataSpec) -> bool:
        assert isinstance(data, MessageData)
        if query is None:
            return True
        if query.conversation is not None and query.conversation != data.conversation:
            return False
        return query.since is None or (data.sent_at is not None and data.sent_at >= query.since)

    def _store(self, data: DataSpec, key: Optional[str] = None) -> MessageItem:
        assert isinstance(data, MessageData)
        if data.conversation is not None:
            self._conversations.add(data.conversation)
        item = super()._store(data, key)
        assert isinstance(item, MessageItem)
        return item

    async def receive(self, data: MessageData) -> MessageItem:
        """Record an incoming message, as a provider would deliver it."""
        self._require_open()
        return self._store(data)

    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        check_outgoing(data, reply=False)
        if data.conversation is None:
            return self._deliver(data, conversation=self._conversation_for(data.recipients))
        if data.conversation not in self._conversations:
            raise NotFound("conversation does not exist", origin=data.conversation)
        return self._deliver(data)

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        key = self._scope.key(origin)
        check_outgoing(data, reply=True)
        target = self._records.get(key)
        if target is None:
            raise NotFound("reply target does not exist", origin=origin)
        assert isinstance(target, MessageData)
        return self._deliver(data, conversation=target.conversation, in_reply_to=origin)

    async def draft(self, data: MessageData) -> MessageItem:
        self._require_open()
        check_outgoing(data, reply=False)
        return self._store(data.model_copy(update={"sender": self.sender}), key=f"draft-{next(self._keys):08d}")

    def _deliver(self, data: MessageData, **routing: Optional[CloudOrigin]) -> MessageItem:
        return self._store(data.model_copy(update={"sender": self.sender, "sent_at": datetime.now(timezone.utc), **routing}))

    def _conversation_for(self, recipients: Iterable[UserProfile]) -> CloudOrigin:
        """One recipient set, in any order and with duplicates, maps to exactly one conversation."""
        members = sorted({(r.origin.kind, r.origin.namespace, r.origin.key) for r in recipients})
        return CloudOrigin(kind=self._scope.kind, namespace=f"{self._scope.namespace}/conversations", key=json.dumps(members))


def check_outgoing(data: object, *, reply: bool) -> None:
    """The input rules every ``send``/``reply``/``draft`` shares: text is required, attachments are
    not sent, provider-assigned fields must be empty, and routing is exactly one of a known
    conversation or recipients — or, for a reply, neither."""
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    if data.text is None:
        raise ValueError("text is required")
    if data.attachments:
        raise ValueError("sending attachments is not supported")
    for name in ("sender", "sent_at", "in_reply_to"):
        if getattr(data, name) is not None:
            raise ValueError(f"{name} is assigned by the provider and must be None")
    addressed = (data.conversation is not None, bool(data.recipients))
    if reply and any(addressed):
        raise ValueError("reply routing comes from the answered message; conversation and recipients must be empty")
    if not reply and addressed[0] == addressed[1]:
        raise ValueError("send needs exactly one of conversation or recipients")


__all__ = ["MemoryMessages", "MemorySource", "MemoryStore", "check_outgoing"]
