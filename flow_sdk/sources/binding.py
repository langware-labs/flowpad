"""``SourceBinding`` — everything a source class needs to become one configured source.

The single constructor argument, on every altitude: the runtime builds it from a
``DataSource`` row, a host receives it in its ``open`` frame, a test builds it by hand.
``config`` is the row's provider-opaque configuration, already coerced by the manifest's
field types and never carrying a secret; secrets arrive in ``credentials``.
"""

from __future__ import annotations

from typing import Any, ClassVar, Optional

from pydantic import Field

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.sources.credentials import Credentials


class SourceBinding(DataSpec):
    spec_kind: ClassVar[str] = "source.binding"

    source_id: str = ""
    name: str = ""
    account_key: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    credentials: Credentials = Field(default_factory=Credentials)
    #: A per-row page size, when the row overrides the class default.
    page_size: Optional[int] = Field(default=None, ge=1)
    #: The ``FLOW_INSTANCE`` a source belongs to; a host resolves its own backend from it.
    instance: str = ""


__all__ = ["SourceBinding"]
