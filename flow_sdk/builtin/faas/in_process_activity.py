"""In-process activity tracker for long-running scan/index jobs.

Holds the latest ``IndexProgressTable`` snapshot from the indexer plus the
duplicate-prevention metadata (``job_name``, ``entity_id``, ``started_at``,
``timeout_seconds``). Multiple HTTP requests can observe the same running
job and duplicate starts can be rejected.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

from flow_sdk.fs_store.indexer import PROGRESS_TEXT_COMPLETE, IndexProgressTable, TypeProgressRow


@dataclass
class InProcessActivity:
    """Tracks the live state of a scan/index job on a ComputeNode."""

    job_name: str
    entity_id: str
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    timeout_seconds: int = 600
    latest_table: IndexProgressTable | None = None

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
