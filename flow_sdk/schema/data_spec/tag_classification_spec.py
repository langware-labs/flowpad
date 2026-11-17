"""Values of the generic tag classifier (``flow_sdk/tags/classify.py``) and its message input."""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.schema.data_spec.message_state_spec import MessageState
from flow_sdk.schema.data_spec.spec import DataSpec


class TagClassification(DataSpec):
    """Where a value lands: one full dot tag under the asked root."""

    spec_kind: ClassVar[str] = "tags.classification"

    tag: str
    confidence: float = 0.0


class MessageContextSpec(DataSpec):
    """What a message is classified on. Just the message for now; the person's past
    classifications, the channel and the topic join it here."""

    spec_kind: ClassVar[str] = "stream_inbox.message.context"

    message: MessageState
