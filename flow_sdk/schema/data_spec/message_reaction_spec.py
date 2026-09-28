"""``MessageReaction`` — one person's emoji on a message, as the app keeps it.

The state a channel's reaction reports fold into (``ReactionData`` is the report; this is the result).
A message holds a list of them: one entry per (person, emoji). ``by`` is the reacting identity on the
channel (the sender's origin key); ``ours`` marks the ones this machine put there, so a surface can
offer "take it back" without comparing ids.

Local only: ``FlowMessage.reactions`` is PRIVATE — the projection re-derives it from the SourceItem.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import AwareDatetime, ConfigDict

from flow_sdk.schema.data_spec.spec import DataSpec


class MessageReaction(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "message.reaction"

    emoji: str
    by: str
    by_name: Optional[str] = None
    ours: bool = False
    at: Optional[AwareDatetime] = None


__all__ = ["MessageReaction"]
