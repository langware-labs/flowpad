"""Composable query for filtering, sorting, and paginating Records.

Usage::

    q = RecordQuery(
        types=["claude_session"],
        modified_after=datetime(2026, 1, 1),
        sort_by="modified_at",
        limit=10,
    )
    results = q.apply(records)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Callable, Iterable

if TYPE_CHECKING:
    from .record import Record
    from .scope import Scope


@dataclass
class RecordQuery:
    """Declarative filter + sort + pagination for records.

    All filter fields are optional — ``None`` means "no constraint".
    Combine freely; they are AND-ed together.
    """

    # Identity filters
    ids: list[str] | None = None
    types: list[str] | None = None
    status: str | list[str] | None = None

    # Date-range filters (compares against record.created_at / modified_at)
    created_after: datetime | None = None
    created_before: datetime | None = None
    modified_after: datetime | None = None
    modified_before: datetime | None = None

    # Relationship filters
    parent_id: str | None = None
    child_filter: RecordQuery | None = None  # recursive composition

    # Arbitrary predicate (for caller-supplied logic)
    predicate: Callable[[Record], bool] | None = None

    # Pagination & sorting
    limit: int | None = None
    offset: int = 0
    sort_by: str | None = None  # "created_at", "modified_at", "name"
    sort_desc: bool = True

    # Extended filters
    field_predicates: dict[str, Any] | None = None
    scope: Scope | None = None  # uses string coercion for comparison

    def matches(self, record: Record) -> bool:
        """Return True if *record* passes all filter criteria."""
        if self.ids is not None and record.id not in self.ids:
            return False

        if self.types is not None and record.type not in self.types:
            return False

        if self.status is not None:
            rec_status = str(record.status) if record.status else ""
            if isinstance(self.status, list):
                if rec_status not in self.status:
                    return False
            elif rec_status != self.status:
                return False

        if self.created_after is not None:
            ca = getattr(record, "created_at", None)
            if ca is None or ca < self.created_after:
                return False

        if self.created_before is not None:
            ca = getattr(record, "created_at", None)
            if ca is None or ca > self.created_before:
                return False

        if self.modified_after is not None:
            ma = getattr(record, "modified_at", None)
            if ma is None or ma < self.modified_after:
                return False

        if self.modified_before is not None:
            ma = getattr(record, "modified_at", None)
            if ma is None or ma > self.modified_before:
                return False

        if self.parent_id is not None:
            pr = record.parent_ref
            parent_ok = pr is not None and pr.id == self.parent_id
            if not parent_ok:
                return False

        # Scope filter (value coercion for enum/raw string comparison)
        if self.scope is not None:
            rec_scope = record.scope.value if hasattr(record.scope, 'value') else (record.scope or "")
            query_scope = self.scope.value if hasattr(self.scope, 'value') else self.scope
            if rec_scope != query_scope:
                return False

        # Field predicates — match against record attrs
        if self.field_predicates:
            for key, expected in self.field_predicates.items():
                if getattr(record, key, None) != expected:
                    return False

        if self.predicate is not None and not self.predicate(record):
            return False

        return True

    def apply(self, records: Iterable[Record]) -> list[Record]:
        """Filter, sort, and paginate *records*."""
        # Filter
        result = [r for r in records if self.matches(r)]

        # Sort
        if self.sort_by:
            key_attr = self.sort_by

            def _sort_key(r: Record) -> Any:
                val = getattr(r, key_attr, None)
                if val is None:
                    # Push None to the end regardless of direction
                    return (1, "")
                return (0, val)

            result.sort(key=_sort_key, reverse=self.sort_desc)

        # Paginate
        if self.offset:
            result = result[self.offset:]
        if self.limit is not None:
            result = result[:self.limit]

        return result

    def to_provider_params(self) -> dict:
        """Serialize query as pushdown-safe dict for external providers.

        Returns dict with top-level filter params + nested "fields" key
        for field_predicates to avoid key collision.
        """
        params: dict[str, Any] = {}
        if self.types:
            params["types"] = self.types
        if self.status:
            params["status"] = self.status
        if self.modified_after:
            params["modified_after"] = self.modified_after.isoformat()
        if self.modified_before:
            params["modified_before"] = self.modified_before.isoformat()
        if self.created_after:
            params["created_after"] = self.created_after.isoformat()
        if self.created_before:
            params["created_before"] = self.created_before.isoformat()
        if self.ids:
            params["ids"] = self.ids
        if self.parent_id:
            params["parent_id"] = self.parent_id
        if self.scope:
            params["scope"] = self.scope.value if hasattr(self.scope, 'value') else str(self.scope)
        if self.limit is not None:
            params["limit"] = self.limit
        if self.offset:
            params["offset"] = self.offset
        if self.sort_by:
            params["sort_by"] = self.sort_by
            params["sort_desc"] = self.sort_desc
        if self.field_predicates:
            params["fields"] = self.field_predicates
        return params
