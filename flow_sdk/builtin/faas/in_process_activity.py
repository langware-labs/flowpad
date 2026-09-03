"""In-process activity tracker for long-running scan/index jobs.

Holds the latest ``IndexProgressTable`` snapshot from the indexer plus the
duplicate-prevention metadata (``job_name``, ``entity_id``, ``started_at``,
``timeout_seconds``). Multiple HTTP requests can observe the same running
job and duplicate starts can be rejected.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from flow_sdk.activity.bridge import mirror_table
from flow_sdk.fs_store.indexer import PROGRESS_TEXT_COMPLETE, IndexProgressTable

if TYPE_CHECKING:
    from flow_sdk.activity import Activity

logger = logging.getLogger(__name__)


@dataclass
class InProcessActivity:
    """Tracks the live state of a scan/index job on a ComputeNode."""

    job_name: str
    entity_id: str
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    timeout_seconds: int = 600
    #: Write through :meth:`set_table` ONLY — the setter is what mirrors onto the activity,
    #: and a producer assigning this directly would get the old pill, no chip, and no error
    #: anywhere. Read it through the :attr:`latest_table` property.
    _latest_table: IndexProgressTable | None = None
    #: The ``Activity`` that actually holds the address. Single-flight, queueing and the
    #: liveness bound all live there now; this dataclass survives only to carry the legacy
    #: ``IndexProgressTable`` payload while producers are migrated onto the new shape.
    activity: "Optional[Activity]" = None
    async def wait_released(self) -> None:
        """Block until the holder releases this slot.

        One bound, owned by the claim: waiting here and being claimable there must agree,
        or a waiter sleeps past the moment the slot opened.
        """
        if self.activity is not None:
            await self.activity.wait_released()

    @property
    def is_timed_out(self) -> bool:
        return (datetime.now(timezone.utc) - self.started_at).total_seconds() > self.timeout_seconds

    @property
    def is_complete(self) -> bool:
        """The indexer's terminal snapshot is the ONLY completion signal.

        Deliberately not inferred from ``done >= total``: that holds for the
        whole post-loop orphan sweep, and a mid-sweep "complete" would both
        drop the activity from refresh-time status replay and open
        ``_start_activity``'s duplicate-start gate to a second concurrent
        index run (SQLite writer contention). Abnormal endings are covered by
        the caller's ``finally: _complete_activity(...)`` plus ``is_timed_out``.
        """
        t = self.latest_table
        return t is not None and t.text == PROGRESS_TEXT_COMPLETE

    @property
    def latest_table(self) -> IndexProgressTable | None:
        """The last table this job emitted. Write it with :meth:`set_table`."""
        return self._latest_table

    def set_table(self, table: IndexProgressTable) -> None:
        """Record the latest table AND mirror it onto the activity.

        The single seam that makes every legacy producer visible in the new mechanism
        without rewriting its internals: it already built this table, so reflect it. Both
        shapes go out until the producer is migrated natively, which is what keeps the old
        footer pill working while the new chip fills in.
        """
        self._latest_table = table
        if self.activity is None or self.activity.is_terminal:
            return
        try:
            mirror_table(self.activity, table)
        except Exception:  # noqa: BLE001
            # A mirror must never fail the walk it is describing — but it must not fail
            # SILENTLY either: a producer that renamed a field would otherwise show a
            # blank chip with nothing anywhere saying why.
            logger.debug("activity mirror failed for job %s", self.job_name, exc_info=True)

    def make_flow_data(self) -> dict:
        """Build a ``progress_report`` flow_data envelope from ``latest_table``.

        Returns an empty seed envelope (``rows=[]``, ``done=0``, ``total=0``) if
        no table has arrived yet — keeps the wire shape uniform across the
        very first emit and any later refreshActivityStatus replay.
        """
        if self.latest_table is None:
            attrs: dict = {
                "job_name": self.job_name,
                "rows": [],
                "current": None,
                "done": 0,
                "total": 0,
                "text": None,
                "ts": datetime.now(timezone.utc).isoformat(),
            }
        else:
            attrs = asdict(self.latest_table)
            # asdict turns the rows tuple into a list of dicts — that's what
            # the WS consumer expects (JSON arrays).
            attrs["rows"] = [asdict(r) if not isinstance(r, dict) else r
                             for r in attrs["rows"]]
        return {"element_type": "progress_report", "attributes": attrs}
