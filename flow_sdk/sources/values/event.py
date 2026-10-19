"""``DataSourceEvent`` — what a provider notification says about one resource.

``upsert`` establishes or replaces state, ``delete`` says the source confirmed removal,
``rename`` says the resource that was ``previous_origin`` is now ``origin``, and ``leave``
says it left a selection without being deleted. ``item`` is optional for every kind: a
handler that needs current state fetches it rather than trusting the message.
"""

from __future__ import annotations

from typing import Awaitable, Callable, ClassVar, Optional

from pydantic import model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.sources.values._types import NonBlank
from flow_sdk.sources.values.items import SourceItemSpec
from flow_sdk.sources.values.origin import CloudOrigin


class EventKind(StrEnum):
    UPSERT = "upsert"
    DELETE = "delete"
    LEAVE = "leave"
    RENAME = "rename"


class DataSourceEvent(DataSpec):
    spec_kind: ClassVar[str] = "source.event"

    #: The provider's occurrence id — opaque, stable on replay.
    id: NonBlank
    kind: EventKind
    origin: CloudOrigin
    item: Optional[SourceItemSpec] = None
    previous_origin: Optional[CloudOrigin] = None

    @model_validator(mode="after")
    def _rename_carries_its_previous_origin(self) -> "DataSourceEvent":
        if (self.kind is EventKind.RENAME) != (self.previous_origin is not None):
            raise ValueError("previous_origin is required for a rename and forbidden otherwise")
        return self


ChangeHandler = Callable[[DataSourceEvent], Awaitable[None]]

__all__ = ["ChangeHandler", "DataSourceEvent", "EventKind"]
