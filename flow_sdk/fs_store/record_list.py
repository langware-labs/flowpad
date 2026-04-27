"""Unified RecordList — single collection class for all record types.

Delegates discovery to ``record_class.discover()`` and persistence
to ``record.persist()``, so the collection layer is storage-agnostic.

Replaces the need for callers to choose between ``ResourceRecordList``
(individual files) and ``JsonFileRecordStore`` (embedded JSON).
"""

from __future__ import annotations

import time
from enum import Enum
from typing import Any, Iterator, TYPE_CHECKING

from .exceptions import ReadOnlyProviderError

if TYPE_CHECKING:
    from .provider import RecordProvider
    from .record import Record
    from .record_query import RecordQuery
    from .scope import Scope


class ListMode(Enum):
    """Cache refresh behavior for RecordList."""
    MUTABLE = "mutable"
    IMMUTABLE_WINDOW = "immutable_window"
    SNAPSHOT = "snapshot"


class RecordList:
    """Storage-agnostic typed record collection.

    Read operations delegate to ``provider.discover()`` or
    ``record_class.discover()`` / ``record_class.get()``.
    Write operations delegate to ``record.persist()`` / ``record.save()``
    / ``record.delete()``.

    Parameters:
        record_class: the Record subclass this list manages.
        scope: optional scope passed through to discover().
        provider: optional RecordProvider for external discovery.
        mode: ListMode controlling cache behavior.
        ttl_seconds: auto-invalidation for IMMUTABLE_WINDOW mode.
        **kwargs: forwarded to discover() calls.
    """

    def __init__(
        self,
        record_class: type[Record],
        scope: Scope | None = None,
        provider: RecordProvider | None = None,
        mode: ListMode = ListMode.MUTABLE,
        ttl_seconds: float | None = None,
        **kwargs: Any,
    ) -> None:
        self.record_class = record_class
        self.scope = scope
        self._provider = provider  # TODO: wire to FSProvider when RecordProvider is implemented
        self._mode = mode
        self._ttl_seconds = ttl_seconds
        self._kwargs = kwargs
        # Internal state for IMMUTABLE_WINDOW / SNAPSHOT modes
        self._cached_records: list[Record] | None = None
        self._cached_at: float | None = None
        self._children_source: Record | None = None
        self._children_type: str | None = None

    def _discover(self) -> list[Record]:
        """Fetch records from provider or record_class.discover()."""
        if self._children_source is not None:
            parent = self._children_source
            if self._children_type is not None:
                return list(parent.get_children_by_type(self._children_type))
            return list(parent.children)

        if self._provider is not None:
            return list(self._provider.discover(scope=self.scope, **self._kwargs))

        return list(self.record_class.discover(scope=self.scope, **self._kwargs))

    def _get_records(self) -> list[Record]:
        """Get records respecting the current ListMode."""
        if self._mode == ListMode.MUTABLE:
            return self._discover()

        if self._mode == ListMode.SNAPSHOT:
            if self._cached_records is None:
                self._cached_records = self._discover()
                self._cached_at = time.monotonic()
            return self._cached_records

        # IMMUTABLE_WINDOW
        if self._cached_records is not None:
            if self._ttl_seconds is not None and self._cached_at is not None:
                elapsed = time.monotonic() - self._cached_at
                if elapsed >= self._ttl_seconds:
                    self._cached_records = None
                    self._cached_at = None

        if self._cached_records is None:
            self._cached_records = self._discover()
            self._cached_at = time.monotonic()
        return self._cached_records

    # -- Read (always-fresh for MUTABLE, cached for others) --

    def get(self, record_id: str) -> Record | None:
        """Fetch a single record by id."""
        if self._children_source is not None:
            for r in self._get_records():
                if r.id == record_id:
                    return r
            return None
        return self.record_class.get(record_id, scope=self.scope, **self._kwargs)

    def __iter__(self) -> Iterator[Record]:
        return iter(self._get_records())

    def __len__(self) -> int:
        return len(self._get_records())

    @property
    def records(self) -> list[Record]:
        """Return all records as a list."""
        return list(self)

    @property
    def last_changed_at(self) -> float | None:
        """Manifest mtime or provider-reported mtime."""
        if self._provider is not None and hasattr(self._provider, 'last_changed_at'):
            return self._provider.last_changed_at
        return self._cached_at

    def invalidate(self) -> None:
        """Force provider to re-discover on next access. No-op for SNAPSHOT."""
        if self._mode == ListMode.SNAPSHOT:
            return
        self._cached_records = None
        self._cached_at = None

    # -- Write --

    def create(self, record: Record | dict) -> Record:
        """Persist a new record. Raises ValueError if id already exists."""
        if isinstance(record, dict):
            record = self.record_class.from_dict(record)
        # Check for duplicate
        existing = self.get(record.id)
        if existing is not None:
            raise ValueError(f"Record with id {record.id!r} already exists")
        record.persist()
        self.invalidate()
        return record

    def save(self, record: Record) -> None:
        """Persist a record (create or overwrite).

        For external providers: delegates to provider.write_back(record).
        Raises ReadOnlyProviderError if provider.is_mutable is False.
        """
        if self._provider is not None:
            if hasattr(self._provider, 'is_mutable') and not self._provider.is_mutable:
                raise ReadOnlyProviderError(
                    f"Provider {self._provider!r} is read-only"
                )
            if hasattr(self._provider, 'write_back'):
                self._provider.write_back(record)
                self.invalidate()
                return
        record.persist()
        self.invalidate()

    def update(self, record_id: str, data: dict[str, Any]) -> Record:
        """Fetch, patch fields, and persist. Raises KeyError if missing."""
        record = self.get(record_id)
        if record is None:
            raise KeyError(f"No record with id {record_id!r}")
        for key, value in data.items():
            setattr(record, key, value)
        record.persist()
        self.invalidate()
        return record

    async def delete(self, record_id: str) -> bool:
        """Remove a record. Returns True if it existed."""
        record = self.get(record_id)
        if record is None:
            return False
        await record.delete()
        self.invalidate()
        return True

    # -- Query --

    def query(self, q: RecordQuery) -> list[Record]:
        """If provider supports pushdown, delegate. Otherwise: q.apply(self)."""
        if self._provider is not None and hasattr(self._provider, 'supports_pushdown'):
            if self._provider.supports_pushdown(q):
                return self._provider.query(q)
        return q.apply(self)

    # -- Factory methods --

    @classmethod
    def children_of(
        cls,
        parent: Record,
        child_type: str | None = None,
    ) -> RecordList:
        """RecordList scoped to parent.children_refs. O(k)."""
        from .record import Record as RecordCls
        rl = cls(record_class=RecordCls)
        rl._children_source = parent
        rl._children_type = child_type
        return rl

    @classmethod
    def root(cls, record_class: type[Record]) -> RecordList:
        """Explicit factory for full-scope (all records of a type)."""
        return cls(record_class=record_class)
