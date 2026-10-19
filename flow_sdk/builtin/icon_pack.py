"""``IconPack`` row -- the index of an icon pack asset
(``<scope>/agentic-assets/icon_pack/<name>/icon_pack.json`` + its SVGs).

Indexing one registers it with the icon registry (``flow_sdk.icons``), so its
tags resolve everywhere icons do. ``error`` is what the registry found wrong --
a bad manifest, a missing or unsafe SVG, a kind another pack already declares.
"""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class IconPack(Entity):
    type: str = APIField(default=EntityType.ICON_PACK.value)
    #: The pack's tag namespace (``kind`` in icon_pack.json).
    name: str = APIField(default="")
    description: str = APIField(default="", description="The pack's license line.")
    icon_count: int = APIField(default=0, description="Icons the pack serves.")
    error: str = APIField(default="", description="What is wrong with the pack; empty when it is clean.")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)

    _api_visible: ClassVar[bool] = True
