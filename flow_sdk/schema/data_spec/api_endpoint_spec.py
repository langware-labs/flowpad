"""``APIEndpointOffer`` — a hub ``APIEndpoint`` this box's user may call, as a value.

The hub holds the row and the key; the box only needs to know an endpoint exists, what it
IS (``kinds``) and which vendor it fronts (``host``) to pick a dialect. A projection, field
by field: the hub serializes more (filters, limits, meter) and none of it is the box's.
"""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.schema.data_spec.spec import DataSpec


class APIEndpointOffer(DataSpec):
    spec_kind: ClassVar[str] = "api_endpoint.offer"

    id: str
    name: str = ""
    #: What the API is -- ``"decision"`` marks a decision API. The hub's own tags, verbatim.
    kinds: list[str] = []
    enabled: bool = True
    #: The target's host (``api.typesafe.ai``), never the full URL or the key.
    host: str = ""

    @property
    def typeid(self) -> str:
        return f"api_endpoint-{self.id}"


__all__ = ["APIEndpointOffer"]
