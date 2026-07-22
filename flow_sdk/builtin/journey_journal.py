"""JourneyJournal — a user's private progress through a Journey.

**The journal IS the progress object** — every `Journey` method (`launch`,
`restart`, `advance`, `progress`, `history`, `resume`) returns this row; there is
no separate progress DTO. It is the DURABLE cursor: the live flow run is only the
advance mechanism / one-liner and dies on server restart, while the journal
survives and re-parks the run.

Many journals may exist per (user, journey) — restart archives the current one and
starts a fresh run — but **at most one is active** (status ∈ {new, launched}).
Progress lives HERE, never in the shared Journey folder, so collaborators sharing
one authored Journey keep independent progress.

``steps_left`` is the badge count. ``entries`` is an append-only ledger of step
outcomes. The step DESCRIPTORS are not stored here — they are read from the
journey's ``graph.json``; the UI derives each step's done/current/upcoming state
from ``cursor`` + ``entries``.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class JourneyStatus(str, Enum):
    """new → launched → complete, plus `restarted` for a superseded journal."""

    NEW = "new"              # launched, cursor at entry, nothing advanced yet
    LAUNCHED = "launched"    # in progress (≥1 step advanced)
    COMPLETE = "complete"    # every step done
    RESTARTED = "restarted"  # abandoned by a restart, or superseded by a resume


#: Non-terminal statuses. The one-active invariant: at most one journal per
#: (user, journey) may carry one of these at any time.
ACTIVE_STATUSES: frozenset[str] = frozenset({JourneyStatus.NEW.value, JourneyStatus.LAUNCHED.value})


class JourneyJournal(Entity):
    type: str = APIField(default=EntityType.JOURNEY_JOURNAL.value)

    journey_id: str = APIField(default="")
    user_id: str = APIField(default="")
    status: str = APIField(default=JourneyStatus.NEW.value,
                           description="new | launched | complete | restarted")
    run_id: str = APIField(default="", description="Live AgenticFlowRun advancing this journal.")
    cursor: str = APIField(default="", description="Current guided_step node id ('' when complete).")
    total_steps: int = APIField(default=0)
    steps_left: int = APIField(default=0, description="Badge count = total_steps - completed.")
    entries: list[dict[str, Any]] = APIField(
        default_factory=list, description="Append-only step outcomes: {node_id, event, at}."
    )

    _api_visible: ClassVar[bool] = True

    @property
    def is_active(self) -> bool:
        return self.status in ACTIVE_STATUSES
