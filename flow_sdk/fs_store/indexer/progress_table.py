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

# The one terminal marker. Matched by string at every emit/consume site —
# the indexer's terminal emits, index()'s scan-event filter,
# InProcessActivity.is_complete, the semantic-checker/docs-graph routes —
# so it lives here as the single shared constant. Mirrored on the TS side as
# PROGRESS_TEXT_COMPLETE in ts_sdk/src/services/system-tools-service.ts.
PROGRESS_TEXT_COMPLETE: str = "complete"

# The row ``index()`` appends after the per-type rows while it sweeps away
# entries whose files are gone. Counted in record types checked, not records,
# so it is kept out of the table's done/total. The UI maps the word to
# "Cleaning up" (ui/src/components/footer/activity-words.ts).
SWEEP_ROW_NAME: str = "cleanup"


@dataclass(frozen=True, slots=True)
class ErrorSample:
    """One error, kept so the person can see WHAT failed, not only how many."""

    ref: str      # the file the error is about
    message: str  # the exception text, e.g. the YAML parser's
    code: str = ""  # what failed: "index.identity" | "index.parse"


@dataclass(frozen=True, slots=True)
class TypeProgressRow:
    type_name: str
    done: int          # records processed (parsed + skipped-fresh)
    total: int         # pre-flight count; 0 when unknown (scan/discovery phase)
    errors: int = 0
    skipped: int = 0   # subset of done that was skipped-fresh
    finished: bool = False  # the producer is done with this row, whatever its count
    error_samples: tuple[ErrorSample, ...] = ()  # the first MAX_ERROR_SAMPLE errors, by message


@dataclass(frozen=True, slots=True)
class IndexProgressTable:
    job_name: str                              # "scan" | "index"
    rows: tuple[TypeProgressRow, ...]
    current: str | None                        # type_name of the row in flight
    done: int                                  # sum(row.done)
    total: int                                 # sum(row.total); 0 = unknown
    text: str | None = None                    # PROGRESS_TEXT_COMPLETE on terminal event
    roots: tuple[str, ...] = ()                # paths of the folders this job walks
    ts: str = ""                               # ISO-8601 UTC at emit time
