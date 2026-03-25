"""Artifact record type."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class Artifact(Record):
    _record_type: ClassVar[str] = RecordType.ARTIFACT

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.ARTIFACT)
        super().__init__(**kwargs)
