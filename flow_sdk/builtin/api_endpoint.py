"""``APIEndpoint`` — the hub's API endpoints, seen from a desktop: a type with no local rows.

An API endpoint is a budget over a third-party HTTP API (pictures, video, any cloud API): a root holds
the vendor's key and the price of a call, an allocation draws on it under its own limits. The hub owns
all of it. Declaring the type here, hub-only, is what lets the endpoints screen list and edit them the
way it does LLM endpoints: a desktop proxies every ``api_endpoint`` request to the hub verbatim
(``server/routes/_hub_reflect.decide``). Calling one is ``flow_sdk.endpoint_call``, not this class.
"""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class APIEndpoint(Entity):
    _api_visible: ClassVar[bool] = False
    _hub_only: ClassVar[bool] = True

    type: str = APIField(default=EntityType.API_ENDPOINT.value)

    def is_file_backed(self) -> bool:
        return False

    async def save(self, *args, **kwargs):  # noqa: D401 — a guard, not a verb
        """Refuse: an API endpoint is the hub's row; it has no local copy to save."""
        raise ValueError("an API endpoint is the hub's row — it has no local copy to save")
