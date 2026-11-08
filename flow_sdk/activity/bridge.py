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
from flow_sdk.schema.data_spec.activity_spec import ActivityErrorSpec

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
            # A producer that names its errors (the indexer: file + parser message) is
            # shown by them; one that only counts can say no more than that.
            # Built only when the count grew — the indexer emits on every file.
            error_samples=[
                ActivityErrorSpec(message=f"{e.ref}: {e.message}", ref=e.ref, code=e.code or None)
                for e in row.error_samples
            ]
            if row.errors > child.errors_count
            else (),
            error_message="(legacy producer reported an error without detail)",
        )
        # A type whose count reached its known total is finished — end it now, so the
        # parent's "n/m" counts it. Needed only because legacy rows carry no end signal;
        # it goes with this module.
        if (row.finished or (row_total is not None and row.done >= row_total)) and not child.is_terminal:
            child.done()

    # A step the producer stopped reporting is over — e.g. a type the scan phase counted
    # that the index table does not carry. Left running, the chip would name it as the
    # step at work.
    if table.rows:
        _close_open_steps(node, keep={str(row.type_name) for row in table.rows})

    node.set_progress(done=table.done)

    # `complete` is a state, not something to say. Legacy rows carry no end signal, so a
    # step still open here finished with the job — end it as done, or the root's done()
    # would record it as interrupted.
    if table.text == PROGRESS_TEXT_COMPLETE:
        _close_open_steps(node)
        node.done()
    elif table.text and table.text != node.message_text:
        node.message(table.text)
    elif not table.text and table.roots:
        # Say WHAT is being walked while it runs; paths, so there is nothing to translate.
        where = ", ".join(table.roots)
        if where != node.message_text:
            node.message(where)


def _close_open_steps(node: "Activity", keep: "set[str]" = frozenset()) -> None:
    """End every still-open step of ``node`` as done, except those named in ``keep``."""
    for step in list(node._children.values()):
        if step.name not in keep and not step.is_terminal:
            step.done()


__all__ = ["mirror_table"]
