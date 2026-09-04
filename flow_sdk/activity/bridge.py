"""Mirror a legacy ``IndexProgressTable`` onto the ``Activity`` that holds its slot.

The migration's hinge. Every legacy producer — the indexer, the docs scan, the semantic
check, the clear, the asset-usage scan — already builds a table and broadcasts it. Rather
than rewrite each producer's internals before any of them is visible, this reflects the
table it already built onto the activity that already holds its address, so the whole set
becomes live in the new mechanism at once and the old pill keeps working.

It is deliberately one-directional and temporary: producers move onto ``Activity`` natively
one at a time, and each one that does stops needing this. When the last one has moved, this
module and ``IndexProgressTable`` go together — which is why nothing here is exported for
an outside caller to depend on.

The table carries ABSOLUTE running totals; ``Activity.set_progress`` takes exactly that and
owns the never-backwards rule, so the conversion is a hand-off rather than arithmetic
repeated here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from flow_sdk.fs_store.indexer import PROGRESS_TEXT_COMPLETE, IndexProgressTable

if TYPE_CHECKING:
    from flow_sdk.activity import Activity

#: What each legacy ``job_name`` is called in a sentence, and the glyph it shows. These
#: describe the SHAPE being retired, not the producers — a migrated producer states its own
#: label — so they live here and die with the module rather than being planted on five
#: producers that are about to be rewritten anyway.
_JOB_LABELS: "dict[str, str]" = {
    "scan": "Scanning",
    "index": "Indexing",
    "clear": "Clearing index",
    "archive": "Archiving",
    "load_from_archive": "Restoring",
}
_JOB_ICONS: "dict[str, str]" = {
    "scan": "Search",
    "index": "DatabaseZap",
    "clear": "Trash2",
    "archive": "Archive",
    "load_from_archive": "ArchiveRestore",
}


def mirror_table(node: "Activity", table: IndexProgressTable) -> None:
    """Reflect one emitted table onto ``node``, and end it when the table is the last."""
    # The label follows the CURRENT job name, not the first one seen. An index emits its
    # inner scan's tables first, so pinning the label would leave "Scanning" on screen for
    # the whole run — the very thing the old frontend's `phaseSource` hack worked around.
    label = _JOB_LABELS.get(table.job_name) or table.job_name.replace("_", " ").capitalize() or "Working"
    if label != node.label_text:
        node.label(label)
        node.icon(_JOB_ICONS.get(table.job_name))

    # `total=0` in the old shape means "unknown" (a scan discovers as it goes), which is
    # the confusion this migration exists to end: here it becomes an honest None.
    total = table.total or None
    if total != node.total_count:
        node.total(total)
    if table.current != node.current_item:
        node.current(table.current)

    for row in table.rows:
        child = node.child(str(row.type_name))
        row_total = row.total or None
        if row_total != child.total_count:
            child.total(row_total)
        child.set_progress(
            done=row.done,
            skipped=row.skipped,
            errors=row.errors,
            # The table carries a count and no messages, so the sample can only say that
            # the producer has not been migrated yet. The count is the part that was
            # always true.
            error_message="(legacy producer reported an error without detail)",
        )

    node.set_progress(done=table.done)

    # `complete` is a state, not something to say.
    if table.text == PROGRESS_TEXT_COMPLETE:
        node.done()
    elif table.text and table.text != node.message_text:
        node.message(table.text)


__all__ = ["mirror_table"]
