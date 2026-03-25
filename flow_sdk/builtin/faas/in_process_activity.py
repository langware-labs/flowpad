"""In-process activity tracker for long-running scan/index jobs.

Tracks per-job and per-sub-activity progress so that multiple HTTP requests
can observe the same running job and duplicate starts can be rejected.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class InProcessActivity:
    """Tracks progress of a long-running job (scan or index) on a ComputeNode.

    Two levels of counters:
    - Job-level (done/skipped/errors/total): how many sub-activities (record types)
      have been processed so far out of the total.
    - Sub-activity level (sub_*): per-record counters within the current type.

    Call make_flow_data(sub_activity_name) to build a FlowData dict for
    broadcasting over WebSocket.
    """

    job_name: str
    entity_id: str  # typeid string of the owning compute node
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    timeout_seconds: int = 600

    # Job-level counters (emitted as progress_report with sub_activity_name=None)
    done: int = 0
    skipped: int = 0
    errors: int = 0
    total: int = 0
    text: str | None = None

    # Current sub-activity state (emitted as progress_report with sub_activity_name set)
    sub_activity_name: str | None = None
    sub_done: int = 0
    sub_skipped: int = 0
    sub_errors: int = 0
    sub_total: int = 0
    sub_text: str | None = None

    @property
    def is_timed_out(self) -> bool:
        return (datetime.now(timezone.utc) - self.started_at).total_seconds() > self.timeout_seconds

    @property
    def is_complete(self) -> bool:
        return self.total > 0 and (self.done + self.skipped + self.errors) >= self.total

    def make_flow_data(self, sub_activity_name: str | None = None) -> dict:
        """Build a FlowData dict for broadcasting.

        sub_activity_name=None  → job-level report (done = number of types completed)
        sub_activity_name=str   → sub-activity report (done = records processed in that type)

        All events include a ``ts`` field with the current UTC ISO-8601 timestamp
        so consumers can measure inter-event gaps and debug apparent hangs.
        """
        ts = datetime.now(timezone.utc).isoformat()
        if sub_activity_name is None:
            return {
                "element_type": "progress_report",
                "attributes": {
                    "job_name": self.job_name,
                    "sub_activity_name": None,
                    "done": self.done,
                    "skipped": self.skipped,
                    "errors": self.errors,
                    "total": self.total,
                    "text": self.text,
                    "ts": ts,
                },
            }
        return {
            "element_type": "progress_report",
            "attributes": {
                "job_name": self.job_name,
                "sub_activity_name": sub_activity_name,
                "done": self.sub_done,
                "skipped": self.sub_skipped,
                "errors": self.sub_errors,
                "total": self.sub_total,
                "text": self.sub_text,
                "ts": ts,
            },
        }
