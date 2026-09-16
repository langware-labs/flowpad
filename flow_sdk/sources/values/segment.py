"""``SegmentRef`` — one syncable unit of a source: a feed URL, a channel, a branch.

The contract knows queries; the runtime syncs in segments, each with its own cursor.
A segment is a query with a name the runtime can key a cursor on. ``stamp`` is an optional
change token the LISTING already carries (a message count, an updated-at) so an idle segment
costs no fetch."""

from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.schema.data_spec.spec import DataSpec, Tagged
from flow_sdk.sources.values._types import NonBlank
from flow_sdk.sources.values.query import DataQuery


class SegmentRef(DataSpec):
    spec_kind: ClassVar[str] = "source.segment"

    key: NonBlank
    label: str = ""
    stamp: str = ""
    query: Optional[Tagged[DataQuery]] = None


__all__ = ["SegmentRef"]
