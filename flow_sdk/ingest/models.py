"""The ingestion envelope — header + body, in the network-message sense.

``IngestItem`` is what a driver hands the ingestor: a routing **header** the
subsystem reads (which source, which stream, which record, when) plus a
normalized **body** it stores. ``raw`` rides along uninterpreted so a mapping
bug can be re-derived later without re-fetching from the provider.

Drivers construct these; nothing else does.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

from flow_sdk._compat import StrEnum

IngestStatus = Literal["created", "updated", "unchanged"]

#: Both GraphWorkflow storm caps default to 30/min and silently drop the
#: excess — ``max_entries_per_minute`` on flow subscriptions and
#: ``max_fires_per_minute`` on TAG triggers. A run that would exceed it reports
#: once instead of per item; raising the caps is not available to us.
STORM_CAP_PER_MINUTE = 30


class IngestMode(StrEnum):
    """How loudly a run is allowed to announce itself.

    The two GraphWorkflow storm caps (subscription entries and trigger fires)
    both default to 30/min and silently drop the excess. A backfill of a 7-day
    window emits far more than that, so it must not emit per item at all —
    it reports once, at the end, and a flow fans out from the returned ids.
    Raising the caps is not an option (see AGENTS.md on timeouts and budgets).
    """

    #: First sync, or any run over the per-run item threshold. Saves without
    #: notifying and emits no per-item events.
    BACKFILL = "backfill"
    #: Steady state — a handful of items. Per-item events, normal notification.
    INCREMENTAL = "incremental"

    @classmethod
    def for_run(cls, *, first_run: bool, item_count: int) -> "IngestMode":
        """The mode decision, in one place.

        Both halves matter. A first sync is obviously a backfill, but so is any
        later run that returns more items than the storm caps admit — emitting
        40 events into a 30/min cap pays for all of them and delivers 30.
        """
        if first_run or item_count > STORM_CAP_PER_MINUTE:
            return cls.BACKFILL
        return cls.INCREMENTAL


@dataclass(frozen=True)
class IngestItem:
    # ── header ──
    source_id: str
    provider: str
    kind: str
    segment_key: str
    external_id: str

    # ── body ──
    title: str = ""
    body: str = ""
    occurred_at: Optional[str] = None
    author_external_id: Optional[str] = None
    author_display: Optional[str] = None
    permalink: Optional[str] = None
    thread_key: Optional[str] = None
    reply_to_external_id: Optional[str] = None
    segment_label: str = ""
    raw: Optional[dict] = None


@dataclass(frozen=True)
class IngestOutcome:
    entity_id: str
    external_id: str
    status: IngestStatus


@dataclass
class IngestReport:
    outcomes: list[IngestOutcome] = field(default_factory=list)

    def _count(self, status: IngestStatus) -> int:
        return sum(1 for o in self.outcomes if o.status == status)

    @property
    def created(self) -> int:
        return self._count("created")

    @property
    def updated(self) -> int:
        return self._count("updated")

    @property
    def unchanged(self) -> int:
        """The health signal. In steady state this should dominate — if it is
        near zero on a repeat poll, the digest gate is not working and every
        cycle is rewriting rows and re-firing triggers."""
        return self._count("unchanged")

    @property
    def changed_ids(self) -> list[str]:
        """Entity ids that actually moved — what a sync.completed event carries
        so a flow can fan out without re-querying."""
        return [o.entity_id for o in self.outcomes if o.status != "unchanged"]

    def as_counts(self) -> dict:
        return {
            "created": self.created,
            "updated": self.updated,
            "unchanged": self.unchanged,
        }
