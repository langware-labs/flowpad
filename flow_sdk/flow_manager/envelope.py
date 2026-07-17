"""TopicEvent — the event envelope FlowManager routes.

An event is an *occurrence* on a topic (the topic is the only routing key);
the envelope carries provenance and the budget state loop protection charges
against. Events are ephemeral — journaled, never persisted as entities.
"""
from __future__ import annotations

import uuid
from typing import Any, Optional

from pydantic import BaseModel, Field

from flow_sdk.core.capabilities.models import now_iso


class TopicEvent(BaseModel):
    topic: str
    payload: dict[str, Any] = Field(default_factory=dict)
    # Who emitted: a "type:id" typeid string, or a plain label ("rest", "manual").
    source: str = "manual"
    correlation_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    # Hop chain: "topic@source" strings, oldest first (self not included).
    causation: list[str] = Field(default_factory=list)
    depth: int = 0
    scope: Optional[str] = None
    ts: str = Field(default_factory=now_iso)
    # Control events (protection trips, dead letters) are budget-exempt and
    # never re-dispatched recursively. Set by FlowManager's meta-emit helpers —
    # a flag, not a topic-name convention, so routing never string-matches.
    control: bool = False
    # Stamped by FlowManager on delivery decisions (journal-visible).
    dropped: Optional[str] = Field(
        default=None, description="Reason this event was refused (budget trip), if any."
    )

    def child(self, topic: str, payload: dict[str, Any] | None = None, source: str = "") -> "TopicEvent":
        """Derive a follow-on event that extends this event's chain."""
        return TopicEvent(
            topic=topic,
            payload=payload or {},
            source=source or self.source,
            correlation_id=self.correlation_id,
            causation=[*self.causation, f"{self.topic}@{self.source}"],
            depth=self.depth + 1,
            scope=self.scope,
        )
