"""Record provider protocol and implementations.

Defines the ``RecordProvider`` protocol for pluggable record backends,
plus concrete implementations: ``FSProvider`` (local filesystem) and
``GmailProvider`` (stub/skeleton for external sources).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, runtime_checkable

from typing_extensions import Protocol

if TYPE_CHECKING:
    from .record import Record
    from .record_query import RecordQuery
    from .scope import Scope


@runtime_checkable
class RecordProvider(Protocol):
    """Protocol for record data access backends."""

    def discover(self, record_type: str, scope: Scope | None = None) -> list[Record]:
        """Return all records of the given type."""
        ...

    def get(self, record_type: str, uid: str) -> Record | None:
        """Return a single record by type + uid, or None."""
        ...

    def query(self, q: RecordQuery) -> list[Record]:
        """Execute a query, optionally with pushdown."""
        ...

    def supports_pushdown(self, q: RecordQuery) -> bool:
        """True if this provider can push down the query to its backend."""
        ...

    @property
    def is_mutable(self) -> bool:
        """Whether this provider supports write-back."""
        ...

    def write_back(self, record: Record) -> None:
        """Persist a modified record back to the provider's backend.
        Raises ReadOnlyProviderError if is_mutable is False."""
        ...


class FSProvider:
    """Filesystem-backed record provider.

    Delegates discover/get to Record.discover()/Record.get().
    query() applies RecordQuery in-memory (no pushdown).
    """

    def discover(self, record_type: str, scope: Scope | None = None) -> list[Record]:
        from .factory.type_registry import type_registry
        from .record import Record as BaseRecord
        cls = type_registry.get(record_type) or BaseRecord
        return cls.discover(scope=scope)

    def get(self, record_type: str, uid: str) -> Record | None:
        from .factory.type_registry import type_registry
        from .record import Record as BaseRecord
        cls = type_registry.get(record_type) or BaseRecord
        return cls.get(uid)

    def query(self, q: RecordQuery) -> list[Record]:
        """In-memory filter — no pushdown for local FS."""
        record_types = q.types or []
        all_records: list[Record] = []
        scope = getattr(q, "scope", None)
        if record_types:
            for rt in record_types:
                all_records.extend(self.discover(rt, scope=scope))
        return q.apply(all_records)

    def supports_pushdown(self, q: RecordQuery) -> bool:
        return False

    @property
    def is_mutable(self) -> bool:
        return True

    def write_back(self, record: Record) -> None:
        """Local FS: just save the record directly."""
        record.persist()


class GmailProvider:
    """Stub/skeleton for Gmail provider — interface locked, no real API calls.

    Exists to validate that the RecordProvider protocol works for external sources.
    """

    def __init__(self, credentials: dict | None = None) -> None:
        self._credentials = credentials

    def discover(self, record_type: str, scope: Scope | None = None) -> list[Record]:
        raise NotImplementedError("GmailProvider.discover() not yet implemented")

    def get(self, record_type: str, uid: str) -> Record | None:
        raise NotImplementedError("GmailProvider.get() not yet implemented")

    def query(self, q: RecordQuery) -> list[Record]:
        raise NotImplementedError("GmailProvider.query() not yet implemented")

    def supports_pushdown(self, q: RecordQuery) -> bool:
        return True  # Gmail API supports date range + label filtering

    @property
    def is_mutable(self) -> bool:
        return False  # Read-only for now

    def write_back(self, record: Record) -> None:
        from .exceptions import ReadOnlyProviderError
        raise ReadOnlyProviderError("GmailProvider is read-only")


# -- Provider registry --

_providers: dict[str, RecordProvider] = {}


def register_provider(name: str, provider: RecordProvider) -> None:
    """Register a named provider."""
    _providers[name] = provider


def get_provider(name: str) -> RecordProvider | None:
    """Look up a registered provider by name."""
    return _providers.get(name)
