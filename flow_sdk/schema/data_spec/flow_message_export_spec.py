"""What an offline export carries: the message text and the entities it packs."""
from __future__ import annotations

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.spec import DataSpec


class FlowMessageExportSpec(DataSpec):
    """``POST flow-message-export`` — one message, many entities, no conversation.

    ``asset_references`` are TypeIds (``skill-<uuid>``); each becomes one TYPE_ID
    attachment packed the way a share packs it, so the receiver's upload stages it
    for review exactly like a received message.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    text: str = ""
    asset_references: list[str] = Field(default_factory=list)
