"""Ingestion run vocabulary — the mode decision, an outcome, a report.

The envelope a driver emits is ``SourceItemSpec`` (``flow_sdk/builtin/source_item.py``),
the ``header`` of the row it becomes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

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

    #: Any run over the per-run item threshold. Saves without notifying and
    #: emits no per-item events.
    BACKFILL = "backfill"
    #: Steady state — a handful of items. Per-item events, normal notification.
    INCREMENTAL = "incremental"

    @classmethod
    def for_run(cls, *, item_count: int) -> "IngestMode":
        """The mode decision, in one place: SIZE, and only size.

        A run that returns more items than the storm caps admit is a backfill
        — emitting 40 events into a 30/min cap pays for all of them and
        delivers 30. Whether it is the stream's first run is not the question:
        a first run over the cap is caught by the cap, and a first run under
        it (a support ticket's opening line, a new feed with two entries) is
        exactly the kind of arrival that must announce itself now rather than
        wait for the reconcile sweep to reach it behind a desk's backlog.
        """
        if item_count > STORM_CAP_PER_MINUTE:
            return cls.BACKFILL
        return cls.INCREMENTAL



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
