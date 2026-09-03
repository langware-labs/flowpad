"""Mirror a legacy ``IndexProgressTable`` onto the ``Activity`` that holds its slot.

The migration's hinge. Every legacy producer — the indexer, the docs scan, the semantic
check, the clear, the asset-usage scan — already builds a table and broadcasts it. Rather
than rewrite each producer's internals before any of them is visible, this reflects the
table it already built onto the activity that already holds its address, so the whole set
becomes live in the new mechanism at once and the old pill keeps working unchanged.

It is deliberately one-directional and temporary: producers move onto ``Activity`` natively
one at a time, and each one that does stops needing this. When the last one has moved, this
module and ``IndexProgressTable`` go together.

The table carries ABSOLUTE running totals; the activity's verbs take deltas. Converting
here rather than adding absolute setters to ``Activity`` keeps the verb model honest — a
producer reports what happened, not what the number now is.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from flow_sdk.activity import Activity

#: What each legacy ``job_name`` is called in a sentence. The old frontend held this map
#: as `PHASE_LABELS`; a producer states its own label now, so it moves to the backend and
#: dies with the last legacy producer.
JOB_LABELS: "dict[str, str]" = {
    "scan": "Scanning",
    "index": "Indexing",
    "clear": "Clearing index",
    "archive": "Archiving",
    "load_from_archive": "Restoring",
}

#: The glyph each legacy job shows in the chip. An activity is not an entity type, so it
#: cannot ask the type registry; the producer says.
JOB_ICONS: "dict[str, str]" = {
    "scan": "Search",
    "index": "DatabaseZap",
    "clear": "Trash2",
    "archive": "Archive",
    "load_from_archive": "ArchiveRestore",
}


def _advance(node: "Activity", *, done: int, skipped: int, errors: int) -> None:
    """Move a node's counters to the table's absolute values, as deltas.

    Skips are counted first because they are a SUBSET of done: passing the whole `done`
    delta to `inc_success` and then the skipped delta to `inc_skipped` would count the
    skipped items twice.
    """
    spec = node.spec()
    skipped_delta = max(skipped - spec.skipped, 0)
    done_delta = max(done - spec.done, 0)
    if skipped_delta:
        node.inc_skipped(skipped_delta)
        done_delta = max(done_delta - skipped_delta, 0)
    if done_delta:
        node.inc_success(done_delta)
    error_delta = max(errors - spec.errors_count, 0)
    if error_delta:
        # The table carries a count and no messages, so the sample says only that the
        # producer has not been migrated yet. The count is the part that was always true.
        node.inc_error("(legacy producer reported an error without detail)", n=error_delta)


def mirror_table(node: "Activity", table: Any) -> None:
    """Reflect one emitted table onto ``node``. Never raises: a mirror must not fail a walk."""
    try:
        # The label follows the CURRENT job name, not the first one seen. An index emits
        # its inner scan's tables first, so pinning the label would leave "Scanning" on
        # screen for the whole run — the very thing the old frontend's `phaseSource` hack
        # existed to work around.
        job = getattr(table, "job_name", "") or ""
        label = JOB_LABELS.get(job, job.replace("_", " ").capitalize() or "Working")
        if label != node.label_text:
            node.label(label)
            node.icon(JOB_ICONS.get(job))

        # `total=0` in the old shape means "unknown" (a scan discovers as it goes), which
        # is the confusion this migration exists to end: here it becomes an honest None.
        total = getattr(table, "total", 0) or None
        if total != node.total_count:
            node.total(total)

        current = getattr(table, "current", None)
        if current != node.current_item:
            node.current(current)

        for row in getattr(table, "rows", ()) or ():
            child = node.child(str(row.type_name))
            row_total = getattr(row, "total", 0) or None
            if row_total != child.total_count:
                child.total(row_total)
            _advance(
                child,
                done=getattr(row, "done", 0) or 0,
                skipped=getattr(row, "skipped", 0) or 0,
                errors=getattr(row, "errors", 0) or 0,
            )

        _advance(
            node,
            done=getattr(table, "done", 0) or 0,
            skipped=0,
            errors=0,
        )

        text = getattr(table, "text", None)
        if text and text != _COMPLETE:
            node.message(str(text))
    except Exception:  # noqa: BLE001 — reporting never fails the thing being reported on
        pass


def is_terminal_table(table: Any) -> bool:
    """Whether this table is the producer's last word."""
    return getattr(table, "text", None) == _COMPLETE


_COMPLETE = "complete"


def activity_for(path: str, scope: "Optional[str]") -> "Activity":
    """The activity a legacy producer reports through, without claiming a slot.

    Producers that build an ``InProcessActivity`` by hand (the docs scan, the semantic
    check) never took the slot to begin with, so they get their address the ordinary way.
    """
    from flow_sdk.activity import Activity

    return Activity.get(path, scope=scope)


__all__ = ["JOB_ICONS", "JOB_LABELS", "activity_for", "is_terminal_table", "mirror_table"]
