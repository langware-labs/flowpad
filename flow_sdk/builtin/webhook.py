"""``Webhook`` — the hub's webhook chain, seen from a desktop: a type with no local rows.

The hub owns every claim on a vendor's traffic (a number, a sender, a group — ``webhook/@<provider>`` and the
claims chained under it) and decides everything about it. Declaring the type here, hub-only, is what lets the SDK
call ``webhook/<verb>`` the same way on both backends: a desktop proxies every such request to the hub verbatim
(``server/routes/_hub_reflect.decide``), the hub page calls the hub directly.
"""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class Webhook(Entity):
    _api_visible: ClassVar[bool] = False
    _hub_only: ClassVar[bool] = True

    type: str = APIField(default=EntityType.WEBHOOK.value)

    def is_file_backed(self) -> bool:
        return False

    async def save(self, *args, **kwargs):  # noqa: D401 — a guard, not a verb
        """Refuse: a webhook claim is the hub's row; it is made with ``webhook/chain``."""
        raise ValueError("a webhook claim is the hub's row — it has no local copy to save; use webhook/chain")
