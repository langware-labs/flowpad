"""Snapshot shape for scan/index progress.

The indexer is a graph DFS over heterogeneous FSRef nodes — types are facets
on visited nodes, not phases of work. The progress table reflects that: each
row is a per-type counter that ticks up as the walker encounters records of
that type. The full table is re-broadcast on every update so consumers can
treat each event as a complete state snapshot.

For ``index()`` the totals are known up front (the inner ``scan()`` runs to
completion before the per-record loop). For ``scan()`` the totals are
unknown — discovery is the count — so ``total`` is reported as 0 and the
UI shows count-only.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class TypeProgressRow:
    type_name: str
    done: int          # records processed (parsed + skipped-fresh)
    total: int         # pre-flight count; equals done when total is unknown
    errors: int = 0
    skipped: int = 0   # subset of done that was skipped-fresh


@dataclass(frozen=True, slots=True)
class IndexProgressTable:
    job_name: str                              # "scan" | "index"
    rows: tuple[TypeProgressRow, ...]
    current: str | None                        # type_name of the row in flight
    done: int                                  # sum(row.done)
    total: int                                 # sum(row.total); 0 = unknown
    text: str | None = None                    # "complete" on terminal event
    ts: str = ""                               # ISO-8601 UTC at emit time
