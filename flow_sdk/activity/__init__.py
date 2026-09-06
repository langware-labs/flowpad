"""Activity progress — one generic mechanism for reporting long-running work.

``Activity.get(path)`` finds or creates a progress row; ``.child(name)`` does the same
one level down; every node has the same verbs. Any producer reports through it — an
index, a walk, a RAG pass, a QA cycle, an agentic process — and every consumer reads
one shape, ``ActivityProgressSpec``::

    from flow_sdk.activity import Activity, monitor

    Activity.get("index").label("Indexing").total(5000)
    Activity.get("index/pdf").inc_success()
    Activity.get("index/pdf").inc_error("encrypted", ref="a.pdf")
    Activity.get("index").done("indexed 5,000")

    async with Activity.claim("index", scope=node, timeout_seconds=600, queue=True) as act:
        act.total(5000)     # single-flight: the address IS the slot

    monitor.list()          # what is live right now
    monitor.stale(60)       # what has not ticked in a minute

See ``docs/snippets/activity.md`` for the shelf page and the same verbs in TypeScript,
the CLI and HTTP.
"""

from flow_sdk.activity.activity import SEP, Activity, canonical_verb, split_path
from flow_sdk.activity.progress_monitor import (
    ActivityProgressMonitor,
    Subscriber,
    monitor,
)
from flow_sdk.schema.data_spec.activity_spec import (
    TERMINAL,
    ActivityErrorSpec,
    ActivityProgressSpec,
    ActivityState,
)

__all__ = [
    "SEP",
    "TERMINAL",
    "Activity",
    "ActivityErrorSpec",
    "ActivityProgressMonitor",
    "ActivityProgressSpec",
    "ActivityState",
    "Subscriber",
    "canonical_verb",
    "monitor",
    "split_path",
]
