"""Home-landing Feed entities.

A ``FeedEntry`` is a small, dismissible item shown on the Home landing under the
Join/Start-conversation buttons. It is *generic by discriminator*: ``kind`` names
which payload ``feed_data`` carries (today only ``message_suggest`` →
``MessageSuggest``). This mirrors how the rest of the codebase models variant
payloads (e.g. ``FlowMessage.kind`` + ``Attachment.data``) — the entity registry
keys everything by the ``type`` string, so a true ``Generic[T]`` entity would buy
nothing at the storage layer; ``kind`` + ``feed_data`` is the honest mapping.

``feed_status`` drives visibility: only ``new`` entries render in the Feed; the
Dismiss / Send-to-Support actions flip it to ``dismissed``.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import BaseModel

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class FeedStatus(StrEnum):
    NEW = "new"
    DISMISSED = "dismissed"
    EXPIRED = "expired"


class FeedKind(StrEnum):
    MESSAGE_SUGGEST = "message_suggest"


class MessageSuggest(BaseModel):
    """Payload (the ``T``) for a FeedEntry of kind ``message_suggest``.

    Carries the user-facing header ``text`` and the diagnosis summary
    (``message_text``) so the Feed card renders without an extra fetch. For a real
    *issue* it also points at the (until-then hidden) support ``Conversation`` and
    its summary ``FlowMessage`` — those drive the Report / Forward actions. A
    *no-issue* card (posted only when the user wasn't watching the diagnose modal,
    so they still get the answer) has no conversation: ``conversation_id`` /
    ``flow_message_id`` are absent and the card shows just the summary + Dismiss.
    """

    text: str
    message_text: str
    conversation_id: Optional[str] = None
    flow_message_id: Optional[str] = None


class FeedEntry(Entity):
    type: str = APIField(default="feed_entry")
    # Discriminator: which payload ``feed_data`` carries.
    kind: str = APIField(default=FeedKind.MESSAGE_SUGGEST.value)
    # Visibility lifecycle — only ``new`` renders in the Feed.
    feed_status: str = APIField(default=FeedStatus.NEW.value)
    # Serialized payload (a ``MessageSuggest.model_dump()`` for message_suggest).
    # Kept non-blob so it rides along in bulk list responses and the Feed card
    # renders without a follow-up fetch.
    feed_data: Optional[dict] = APIField(default=None)

    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str | None] = "Bell"
