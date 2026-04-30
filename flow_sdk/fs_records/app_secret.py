"""AppSecret record type for user-defined app secrets. Value lives in OS keyring."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class AppSecretRecord(Record):
    """Metadata for a user-defined app secret. Value lives in OS keyring."""

    _record_type: ClassVar[str] = RecordType.APP_SECRET
    _indexed_by_default: ClassVar[bool] = False
    _user_asset: ClassVar[bool] = True
    _creatable: ClassVar[bool] = False
    index_fields: ClassVar[list[str]] = ["name", "description"]

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.APP_SECRET)
        super().__init__(**kwargs)
