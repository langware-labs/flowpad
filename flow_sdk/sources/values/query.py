"""The query family ``fetch`` and ``iterate`` accept. A source rejects families it cannot
honour with ``Unsupported``; ``None`` is the source's default selection."""

from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import AwareDatetime

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.sources.values.origin import CloudOrigin


class DataQuery(DataSpec):
    spec_kind: ClassVar[str] = "source.query"


class ObjectQuery(DataQuery):
    """Objects beneath a key prefix."""

    spec_kind: ClassVar[str] = "source.query.object"

    prefix: str = ""


class MessageQuery(DataQuery):
    """Messages of one conversation, optionally only those sent at or after ``since``."""

    spec_kind: ClassVar[str] = "source.query.message"

    conversation: Optional[CloudOrigin] = None
    since: Optional[AwareDatetime] = None


class RecordQuery(DataQuery):
    """Record predicates are a provider's own (``JiraQuery(jql=...)``); the family is the hook."""

    spec_kind: ClassVar[str] = "source.query.record"


__all__ = ["DataQuery", "MessageQuery", "ObjectQuery", "RecordQuery"]
