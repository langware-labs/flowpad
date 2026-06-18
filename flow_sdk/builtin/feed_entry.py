"""Home-landing Feed entities.

``FeedEntry`` owns feed lifecycle only. Its ``data`` points at the entity that
should render inside the feed; entry-specific meaning lives on that entity.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class FeedStatus(StrEnum):
    NEW = "new"
    DISMISSED = "dismissed"
    EXPIRED = "expired"


class FeedEntry(Entity):
    type: str = APIField(default="feed_entry")
    # Visibility lifecycle — only ``new`` renders in the Feed.
    feed_status: str = APIField(default=FeedStatus.NEW.value)
    # Feed-management data. For normal entries this is {"type_id": "<type>-<id>"}.
    data: Optional[dict] = APIField(default=None)

    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str | None] = "Bell"
